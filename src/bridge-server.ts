#!/usr/bin/env node
// Zero-dependency bridge server. Every HTTP concern below is implemented with
// Node built-ins so that installing this package pulls in no third-party code.
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { CONFIG } from './config';
import { ScannerEngine } from './engines/scanner-engine';
import { Naps2Engine } from './engines/naps2-engine';
import { SaneEngine } from './engines/sane-engine';
import { getErrorMessage, ScanError } from './errors';
import { Device, ScanFormat, ScanMode, ScanOptions } from './types';

interface RequestContext {
    requestId: string;
}

class HttpError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

const STATIC_MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const SCAN_MIME_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    tiff: 'image/tiff',
};

const STATIC_MAX_AGE_SECONDS = 3600;
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOWED_HEADERS = 'Accept, Content-Type, Authorization';
const CORS_MAX_AGE_SECONDS = 600;
const SHUTDOWN_FORCE_EXIT_MS = 5000;

const EXAMPLE_ROOT = path.join(__dirname, '../example');
const ESM_CLIENT_ROOT = path.join(__dirname, '../dist/esm');

function ensureTempDirectory(): void {
    fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(CONFIG.TEMP_DIR, 0o700);
    } catch {
        // Windows does not use POSIX directory permissions.
    }
}

function cleanupStaleFiles(): void {
    const cutoff = Date.now() - CONFIG.TEMP_FILE_MAX_AGE_MS;
    const filePattern = /^scan_[a-f0-9-]+\.(pdf|jpg|jpeg|png|tiff)$/i;

    for (const entry of fs.readdirSync(CONFIG.TEMP_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !filePattern.test(entry.name)) continue;

        const filePath = path.join(CONFIG.TEMP_DIR, entry.name);
        try {
            if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
        } catch (error) {
            console.warn(`Unable to clean temporary scan file ${entry.name}:`, getErrorMessage(error));
        }
    }
}

async function removeFile(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

ensureTempDirectory();
cleanupStaleFiles();

const localOrigins = new Set([
    `http://127.0.0.1:${CONFIG.PORT}`,
    `http://localhost:${CONFIG.PORT}`,
    `http://[::1]:${CONFIG.PORT}`,
]);

function isAllowedOrigin(origin: string): boolean {
    return localOrigins.has(origin) || CONFIG.ALLOWED_ORIGINS.includes(origin);
}

function getOrigin(req: http.IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    return typeof origin === 'string' && origin.length > 0 ? origin : undefined;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = status;
    res.end(JSON.stringify(payload));
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, ctx: RequestContext): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, status, { error: message, code, requestId: ctx.requestId });
}

function isJsonContentType(headerValue: string | undefined): boolean {
    if (!headerValue) return false;
    const mediaType = headerValue.split(';', 1)[0].trim().toLowerCase();
    return mediaType === 'application/json' || (mediaType.length > 5 && mediaType.endsWith('+json'));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let settled = false;

        req.on('data', (chunk: Buffer) => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (receivedBytes > CONFIG.JSON_BODY_LIMIT_BYTES) {
                settled = true;
                req.resume();
                reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            if (chunks.length === 0) {
                // Parity with body-parser: an empty JSON body resolves to {}.
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new HttpError(400, 'INVALID_JSON', 'Request body must contain valid JSON'));
            }
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(new HttpError(400, 'INVALID_REQUEST', getErrorMessage(error)));
        });
    });
}

/**
 * Resolves a decoded URL subpath inside rootDir. Returns null for any path
 * that escapes the root, targets a dotfile, or carries unusual separators.
 */
function resolveStaticPath(rootDir: string, subpath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(subpath);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;

    const segments = decoded.split('/').filter(segment => segment.length > 0);
    if (segments.some(segment =>
        segment === '..' || segment === '.' || segment.startsWith('.') || segment.includes('\\')
    )) {
        return null;
    }

    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, ...segments);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, rootDir: string, subpath: string): Promise<void> {
    const relativePath = subpath === '' || subpath === '/' ? '/index.html' : subpath;
    const filePath = resolveStaticPath(rootDir, relativePath);
    if (!filePath) {
        sendError(res, 404, 'NOT_FOUND', 'Not found', ctx);
        return;
    }

    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) stats = await fs.promises.stat(path.join(filePath, 'index.html'));
    } catch {
        sendError(res, 404, 'NOT_FOUND', 'Not found', ctx);
        return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', `public, max-age=${STATIC_MAX_AGE_SECONDS}`);
    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    await new Promise<void>(resolve => {
        const stream = fs.createReadStream(filePath);
        stream.once('error', (error) => {
            console.error(`[${ctx.requestId}] Static file error:`, getErrorMessage(error));
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                sendError(res, 500, 'DELIVERY_FAILED', 'Unable to deliver the file', ctx);
            } else {
                res.destroy();
            }
            resolve();
        });
        res.once('close', () => resolve());
        stream.pipe(res);
    });
}

const engines: ScannerEngine[] = [new Naps2Engine(), new SaneEngine()];
let cachedEngine: { engine: ScannerEngine; checkedAt: number } | null = null;
let engineDiscovery: Promise<ScannerEngine> | null = null;
let scanInProgress = false;
let deviceCache: { engineName: string; devices: Device[]; expiresAt: number } | null = null;
const scanAttempts = new Map<string, number[]>();
let activeScanAbort: AbortController | null = null;

async function getEngine(forceRefresh = false): Promise<ScannerEngine> {
    if (!forceRefresh && cachedEngine && Date.now() - cachedEngine.checkedAt < CONFIG.ENGINE_CACHE_TTL_MS) {
        return cachedEngine.engine;
    }
    if (engineDiscovery) return engineDiscovery;

    engineDiscovery = (async () => {
        for (const engine of engines) {
            if (await engine.isAvailable()) {
                console.log(`Using Scanner Engine: ${engine.name}`);
                cachedEngine = { engine, checkedAt: Date.now() };
                return engine;
            }
        }
        throw new ScanError('NO_ENGINE', 'No supported scanner software found (NAPS2 or SANE).', null, 503);
    })();

    try {
        return await engineDiscovery;
    } finally {
        engineDiscovery = null;
    }
}

function publicError(error: unknown, fallback: string): { status: number; code: string; message: string } {
    if (error instanceof ScanError) {
        const status = error.httpStatus >= 400 && error.httpStatus < 600 ? error.httpStatus : 500;
        return {
            status,
            code: error.code,
            message: status >= 500 ? fallback : error.message,
        };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: fallback };
}

function scanRateLimit(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): boolean {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    if (scanAttempts.size > 1000) {
        for (const [candidate, timestamps] of scanAttempts) {
            if (!timestamps.some(timestamp => now - timestamp < CONFIG.RATE_LIMIT_WINDOW_MS)) {
                scanAttempts.delete(candidate);
            }
        }
    }

    const recentAttempts = (scanAttempts.get(key) || [])
        .filter(timestamp => now - timestamp < CONFIG.RATE_LIMIT_WINDOW_MS);

    if (recentAttempts.length === 0) scanAttempts.delete(key);

    if (recentAttempts.length >= CONFIG.MAX_SCAN_REQUESTS_PER_WINDOW) {
        const retryAfter = Math.max(1, Math.ceil((recentAttempts[0] + CONFIG.RATE_LIMIT_WINDOW_MS - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        sendError(res, 429, 'RATE_LIMITED', 'Too many scan requests. Please wait before trying again.', ctx);
        return false;
    }

    recentAttempts.push(now);
    scanAttempts.set(key, recentAttempts);
    return true;
}

function parseScanRequest(body: unknown): ScanOptions | { error: { error: string; code: string } } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { error: { error: 'Request body must be a JSON object', code: 'INVALID_REQUEST' } };
    }

    const input = body as Record<string, unknown>;
    const allowedKeys = new Set(['format', 'deviceId', 'dpi', 'mode']);
    const unknownKey = Object.keys(input).find(key => !allowedKeys.has(key));
    if (unknownKey) {
        return { error: { error: `Unsupported scan option: ${unknownKey}`, code: 'INVALID_REQUEST' } };
    }

    const rawFormat = input.format === undefined ? 'pdf' : input.format;
    if (typeof rawFormat !== 'string') {
        return { error: { error: 'Format must be a string', code: 'INVALID_FORMAT' } };
    }

    const format = rawFormat.trim().toLowerCase() as ScanFormat;
    if (!CONFIG.ALLOWED_FORMATS.includes(format)) {
        return { error: { error: `Invalid format. Supported: ${CONFIG.ALLOWED_FORMATS.join(', ')}`, code: 'INVALID_FORMAT' } };
    }

    const result: ScanOptions = { format };
    if (input.deviceId !== undefined && input.deviceId !== null && input.deviceId !== '') {
        if (typeof input.deviceId !== 'string') {
            return { error: { error: 'Device ID must be a string', code: 'INVALID_DEVICE_ID' } };
        }

        const deviceId = input.deviceId.trim();
        if (!deviceId || deviceId.length > CONFIG.MAX_DEVICE_ID_LENGTH || /[\u0000-\u001F\u007F]/.test(deviceId)) {
            return { error: { error: `Device ID must be between 1 and ${CONFIG.MAX_DEVICE_ID_LENGTH} safe characters`, code: 'INVALID_DEVICE_ID' } };
        }
        result.deviceId = deviceId;
    }

    if (input.dpi !== undefined) {
        if (typeof input.dpi !== 'number' || !Number.isInteger(input.dpi) || input.dpi < 75 || input.dpi > 600) {
            return { error: { error: 'DPI must be an integer between 75 and 600', code: 'INVALID_DPI' } };
        }
        result.dpi = input.dpi;
    }

    if (input.mode !== undefined) {
        if (input.mode !== 'color' && input.mode !== 'gray' && input.mode !== 'bw') {
            return { error: { error: 'Mode must be color, gray, or bw', code: 'INVALID_MODE' } };
        }
        result.mode = input.mode as ScanMode;
    }

    return result;
}

// --- Endpoints ---

async function handleHealth(res: http.ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const engine = await getEngine();
        sendJson(res, 200, {
            status: 'ok',
            engine: engine.name,
            version: CONFIG.VERSION,
            formats: CONFIG.ALLOWED_FORMATS,
            busy: scanInProgress,
        });
    } catch (error) {
        console.warn('Health check: no scanner engine available:', getErrorMessage(error));
        sendJson(res, 503, {
            status: 'error',
            error: 'No scanner engine is available',
            code: 'NO_ENGINE',
            version: CONFIG.VERSION,
            busy: scanInProgress,
        });
    }
}

async function handleDevices(url: URL, res: http.ServerResponse, ctx: RequestContext): Promise<void> {
    const refresh = url.searchParams.get('refresh') === 'true' || url.searchParams.get('refresh') === '1';
    try {
        const engine = await getEngine();
        if (!refresh && deviceCache && deviceCache.engineName === engine.name && deviceCache.expiresAt > Date.now()) {
            res.setHeader('Cache-Control', 'no-store');
            sendJson(res, 200, { devices: deviceCache.devices });
            return;
        }

        const devices = await engine.listDevices();
        deviceCache = { engineName: engine.name, devices, expiresAt: Date.now() + CONFIG.DEVICE_CACHE_TTL_MS };
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, { devices });
    } catch (error) {
        console.error('Device list error:', getErrorMessage(error));
        const result = publicError(error, 'Unable to list scanners');
        sendError(res, result.status, result.code, result.message, ctx);
    }
}

function sendScanFile(res: http.ServerResponse, ctx: RequestContext, filePath: string, extension: string, size: number): Promise<void> {
    return new Promise<void>(resolve => {
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            void removeFile(filePath)
                .catch(error => console.error('Scan cleanup error:', getErrorMessage(error)))
                .finally(resolve);
        };

        // 'close' fires both after a successful delivery and on client aborts.
        res.once('close', cleanup);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `inline; filename="scanned_document.${extension}"`);
        res.statusCode = 200;
        res.setHeader('Content-Type', SCAN_MIME_TYPES[extension] || 'application/octet-stream');
        res.setHeader('Content-Length', size);

        const stream = fs.createReadStream(filePath);
        stream.once('error', (error) => {
            console.error(`[${ctx.requestId}] Scan delivery error:`, getErrorMessage(error));
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                sendError(res, 500, 'DELIVERY_FAILED', 'Unable to deliver the scan result', ctx);
            } else {
                res.destroy();
            }
            cleanup();
        });
        stream.pipe(res);
    });
}

async function handleScan(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): Promise<void> {
    if (scanInProgress) {
        res.setHeader('Retry-After', '5');
        sendError(res, 409, 'SCAN_IN_PROGRESS', 'A scan is already in progress.', ctx);
        return;
    }
    if (!scanRateLimit(req, res, ctx)) return;

    let body: unknown;
    try {
        body = isJsonContentType(req.headers['content-type']) ? await readJsonBody(req) : undefined;
    } catch (error) {
        if (error instanceof HttpError) {
            sendError(res, error.status, error.code, error.message, ctx);
            return;
        }
        throw error;
    }

    const request = parseScanRequest(body);
    if ('error' in request) {
        sendError(res, 400, request.error.code, request.error.error, ctx);
        return;
    }

    scanInProgress = true;
    const scanId = crypto.randomUUID();
    const ext = request.format === 'jpeg' ? 'jpg' : request.format;
    const finalFilePath = path.join(CONFIG.TEMP_DIR, `scan_${scanId}.${ext}`);
    const abortController = new AbortController();
    activeScanAbort = abortController;
    const abortScan = () => abortController.abort();
    req.once('aborted', abortScan);
    res.once('close', () => {
        if (!res.writableFinished) abortScan();
    });

    try {
        const engine = await getEngine();
        console.log(`Starting scan with ${engine.name}...`);
        await engine.scan(request, finalFilePath, abortController.signal);

        if (abortController.signal.aborted) {
            throw new ScanError('SCAN_ABORTED', 'Scan cancelled.', null, 499);
        }

        const fileStats = await fs.promises.lstat(finalFilePath).catch(() => null);
        if (!fileStats?.isFile() || fileStats.size === 0) {
            throw new ScanError('FILE_MISSING', 'Scan finished without a readable output file.', null, 500);
        }
        if (fileStats.size > CONFIG.MAX_SCAN_BYTES) {
            throw new ScanError('FILE_TOO_LARGE', 'The scanned file exceeds the configured size limit.', null, 413);
        }
        try {
            await fs.promises.chmod(finalFilePath, 0o600);
        } catch (error) {
            throw new ScanError('FILE_PERMISSION_FAILED', 'Unable to secure the scan output file.', getErrorMessage(error), 500);
        }

        await sendScanFile(res, ctx, finalFilePath, ext, fileStats.size);
    } catch (error) {
        const result = publicError(error, 'Scan failed');
        console.error(`[${ctx.requestId}] Scan error (${result.code}):`, getErrorMessage(error));
        if (result.status >= 500) {
            cachedEngine = null;
            deviceCache = null;
        }
        sendError(res, result.status, result.code, result.message, ctx);
    } finally {
        req.removeListener('aborted', abortScan);
        activeScanAbort = null;
        await removeFile(finalFilePath).catch(error => console.error('Scan cleanup error:', getErrorMessage(error)));
        scanInProgress = false;
    }
}

function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = getOrigin(req);
    if (!origin) return;
    res.setHeader('Vary', 'Origin');
    if (isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
}

function handlePreflight(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): void {
    const origin = getOrigin(req);
    if (origin && !isAllowedOrigin(origin)) {
        sendError(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed to access the local bridge', ctx);
        return;
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));
    }
    res.writeHead(204);
    res.end();
}

function isAuthorized(req: http.IncomingMessage): boolean {
    if (!CONFIG.API_TOKEN) return true;

    const authorization = req.headers.authorization || '';
    const receivedToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
    const expected = Buffer.from(CONFIG.API_TOKEN);
    const received = Buffer.from(receivedToken);
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();

    let url: URL;
    try {
        url = new URL(req.url || '/', 'http://localhost');
    } catch {
        sendError(res, 404, 'NOT_FOUND', 'Not found', ctx);
        return;
    }
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
        handlePreflight(req, res, ctx);
        return;
    }

    if (pathname === '/health' || pathname === '/devices' || pathname === '/scan') {
        const origin = getOrigin(req);
        if (origin && !isAllowedOrigin(origin)) {
            sendError(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed to access the local bridge', ctx);
            return;
        }
        if (!isAuthorized(req)) {
            sendError(res, 401, 'UNAUTHORIZED', 'A valid bridge token is required', ctx);
            return;
        }
    }

    if (pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
        await handleHealth(res);
        return;
    }
    if (pathname === '/devices' && (method === 'GET' || method === 'HEAD')) {
        await handleDevices(url, res, ctx);
        return;
    }
    if (pathname === '/scan' && method === 'POST') {
        await handleScan(req, res, ctx);
        return;
    }
    if (method === 'GET' || method === 'HEAD') {
        if (pathname === '/example' || pathname.startsWith('/example/')) {
            await serveStatic(req, res, ctx, EXAMPLE_ROOT, pathname.slice('/example'.length));
            return;
        }
        if (pathname === '/dist/esm' || pathname.startsWith('/dist/esm/')) {
            await serveStatic(req, res, ctx, ESM_CLIENT_ROOT, pathname.slice('/dist/esm'.length));
            return;
        }
    }
    sendError(res, 404, 'NOT_FOUND', 'Not found', ctx);
}

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ctx: RequestContext = { requestId: crypto.randomUUID() };
    res.setHeader('X-Request-Id', ctx.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:${CONFIG.PORT} http://localhost:${CONFIG.PORT} http://[::1]:${CONFIG.PORT}`
    );
    applyCorsHeaders(req, res);

    handleRequest(req, res, ctx).catch(error => {
        console.error('Unhandled bridge error:', getErrorMessage(error));
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal bridge error', ctx);
    });
}

function createBridgeServer(): http.Server {
    return http.createServer(requestHandler);
}

const CLI_HELP = `Scan2Form Bridge v${CONFIG.VERSION}

Usage: scan2form-server [options]

Options:
  --help      Show this help text
  --version   Print the bridge version

Configuration is provided through environment variables:

  PORT=${CONFIG.PORT}                              Listen port
  HOST=${CONFIG.HOST}                        Bind address (keep on loopback)
  SCAN2FORM_ALLOWED_ORIGINS                Comma-separated browser origin allowlist
  SCAN2FORM_API_TOKEN                      Optional bearer token required by clients
  NAPS2_DRIVER                             NAPS2 driver (wia, twain, sane, escl, apple)

See the README for the full list of supported variables.`;

export { createBridgeServer };

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(CLI_HELP);
        process.exit(0);
    }
    if (args.includes('--version') || args.includes('-v')) {
        console.log(CONFIG.VERSION);
        process.exit(0);
    }

    const server = createBridgeServer();
    server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${CONFIG.PORT} is already in use. Stop the other process or set PORT to a different value.`);
        } else {
            console.error('Bridge server error:', getErrorMessage(error));
        }
        process.exit(1);
    });

    server.listen(CONFIG.PORT, CONFIG.HOST, () => {
        console.log(`Scan2Form Bridge running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
        console.log(`Open Example: http://${CONFIG.HOST}:${CONFIG.PORT}/example/index.html`);
        if (CONFIG.HOST !== '127.0.0.1' && CONFIG.HOST !== 'localhost' && CONFIG.HOST !== '::1') {
            console.warn('Warning: the bridge is bound beyond loopback. Use firewall rules and an API token before exposing it to a network.');
        }
        if (CONFIG.ALLOWED_ORIGINS.length > 0) console.log(`Allowed browser origins: ${CONFIG.ALLOWED_ORIGINS.join(', ')}`);
        if (CONFIG.API_TOKEN) console.log('API token authentication is enabled.');
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\nReceived ${signal}. Shutting down...`);
        activeScanAbort?.abort();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_MS).unref();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}
