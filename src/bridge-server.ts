#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from './config';
import { ScannerEngine } from './engines/scanner-engine';
import { Naps2Engine } from './engines/naps2-engine';
import { SaneEngine } from './engines/sane-engine';
import { getErrorMessage, ScanError } from './errors';
import { Device, ScanFormat, ScanMode, ScanOptions } from './types';

const app = express();
app.disable('x-powered-by');

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

function isRequestOriginAllowed(req: express.Request): boolean {
    const origin = req.get('origin');
    if (!origin) return true;
    return isAllowedOrigin(origin);
}

function originGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!isRequestOriginAllowed(req)) {
        res.status(403).json({
            error: 'Origin is not allowed to access the local bridge',
            code: 'ORIGIN_NOT_ALLOWED',
        });
        return;
    }
    next();
}

function tokenGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (req.method === 'OPTIONS' || !CONFIG.API_TOKEN) {
        next();
        return;
    }

    const authorization = req.get('authorization') || '';
    const receivedToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
    const expected = Buffer.from(CONFIG.API_TOKEN);
    const received = Buffer.from(receivedToken);
    const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received);

    if (!matches) {
        res.status(401).json({ error: 'A valid bridge token is required', code: 'UNAUTHORIZED' });
        return;
    }
    next();
}

app.use((req, res, next) => {
    const requestId = uuidv4();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:${CONFIG.PORT} http://localhost:${CONFIG.PORT}`
    );
    next();
});

app.use(cors({
    origin: (origin, callback) => callback(null, origin && isAllowedOrigin(origin) ? origin : false),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Accept', 'Content-Type', 'Authorization'],
    maxAge: 600,
}));

const apiRoutes = ['/health', '/devices', '/scan'];
app.use(apiRoutes, originGuard);
app.use(apiRoutes, tokenGuard);
app.use(express.json({ limit: CONFIG.JSON_BODY_LIMIT, strict: true }));

const engines: ScannerEngine[] = [new Naps2Engine(), new SaneEngine()];
let cachedEngine: { engine: ScannerEngine; checkedAt: number } | null = null;
let engineDiscovery: Promise<ScannerEngine> | null = null;
let scanInProgress = false;
let deviceCache: { engineName: string; devices: Device[]; expiresAt: number } | null = null;
const scanAttempts = new Map<string, number[]>();

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

function sendError(res: express.Response, status: number, code: string, message: string): void {
    if (res.headersSent || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json({ error: message, code, requestId: res.locals.requestId });
}

function scanRateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
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

    if (recentAttempts.length >= CONFIG.MAX_SCAN_REQUESTS_PER_WINDOW) {
        const retryAfter = Math.max(1, Math.ceil((recentAttempts[0] + CONFIG.RATE_LIMIT_WINDOW_MS - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        sendError(res, 429, 'RATE_LIMITED', 'Too many scan requests. Please wait before trying again.');
        return;
    }

    recentAttempts.push(now);
    scanAttempts.set(key, recentAttempts);
    next();
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

app.get('/health', async (_req, res) => {
    try {
        const engine = await getEngine();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            status: 'ok',
            engine: engine.name,
            version: CONFIG.VERSION,
            formats: CONFIG.ALLOWED_FORMATS,
            busy: scanInProgress,
        });
    } catch (error) {
        console.warn('Health check: no scanner engine available:', getErrorMessage(error));
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({
            status: 'error',
            error: 'No scanner engine is available',
            code: 'NO_ENGINE',
            version: CONFIG.VERSION,
            busy: scanInProgress,
        });
    }
});

app.use('/example', express.static(path.join(__dirname, '../example'), {
    dotfiles: 'deny',
    maxAge: '1h',
}));
// Expose only the browser bundle. The server bundle contains local process details and is not a web asset.
app.use('/dist/esm', express.static(path.join(__dirname, '../dist/esm'), {
    dotfiles: 'deny',
    maxAge: '1h',
}));

app.get('/devices', async (req, res) => {
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    try {
        const engine = await getEngine();
        if (!refresh && deviceCache && deviceCache.engineName === engine.name && deviceCache.expiresAt > Date.now()) {
            res.setHeader('Cache-Control', 'no-store');
            res.json({ devices: deviceCache.devices });
            return;
        }

        const devices = await engine.listDevices();
        deviceCache = { engineName: engine.name, devices, expiresAt: Date.now() + CONFIG.DEVICE_CACHE_TTL_MS };
        res.setHeader('Cache-Control', 'no-store');
        res.json({ devices });
    } catch (error: any) {
        console.error('Device list error:', getErrorMessage(error));
        const result = publicError(error, 'Unable to list scanners');
        sendError(res, result.status, result.code, result.message);
    }
});

app.post('/scan', scanRateLimit, async (req, res) => {
    if (scanInProgress) {
        res.setHeader('Retry-After', '5');
        sendError(res, 409, 'SCAN_IN_PROGRESS', 'A scan is already in progress.');
        return;
    }

    const request = parseScanRequest(req.body);
    if ('error' in request) {
        sendError(res, 400, request.error.code, request.error.error);
        return;
    }

    scanInProgress = true;
    const scanId = uuidv4();
    const ext = request.format === 'jpeg' ? 'jpg' : request.format;
    const finalFilePath = path.join(CONFIG.TEMP_DIR, `scan_${scanId}.${ext}`);
    const abortController = new AbortController();
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

        await sendScanFile(res, finalFilePath, ext);
    } catch (error: any) {
        const result = publicError(error, 'Scan failed');
        console.error(`[${res.locals.requestId}] Scan error (${result.code}):`, getErrorMessage(error));
        if (result.status >= 500) {
            cachedEngine = null;
            deviceCache = null;
        }
        sendError(res, result.status, result.code, result.message);
    } finally {
        req.removeListener('aborted', abortScan);
        await removeFile(finalFilePath).catch(error => console.error('Scan cleanup error:', getErrorMessage(error)));
        scanInProgress = false;
    }
});

async function sendScanFile(res: express.Response, filePath: string, extension: string): Promise<void> {
    await new Promise<void>(resolve => {
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            void removeFile(filePath)
                .catch(error => console.error('Scan cleanup error:', getErrorMessage(error)))
                .finally(resolve);
        };

        res.once('finish', cleanup);
        res.once('close', cleanup);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `inline; filename="scanned_document.${extension}"`);
        res.sendFile(path.basename(filePath), {
            root: CONFIG.TEMP_DIR,
            dotfiles: 'deny',
            cacheControl: false,
        }, error => {
            if (error) {
                console.error(`[${res.locals.requestId}] Scan delivery error:`, getErrorMessage(error));
                sendError(res, 500, 'DELIVERY_FAILED', 'Unable to deliver the scan result');
                cleanup();
            }
        });
    });
}

app.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Not found');
});

app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
        next(error);
        return;
    }
    if (error?.type === 'entity.too.large') {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
        return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
        sendError(res, 400, 'INVALID_JSON', 'Request body must contain valid JSON');
        return;
    }
    console.error('Unhandled bridge error:', getErrorMessage(error));
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal bridge error');
});

export { app };

if (require.main === module) {
    app.listen(CONFIG.PORT, CONFIG.HOST, () => {
        console.log(`Scan2Form Bridge running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
        console.log(`Open Example: http://${CONFIG.HOST}:${CONFIG.PORT}/example/index.html`);
        if (CONFIG.HOST !== '127.0.0.1' && CONFIG.HOST !== 'localhost' && CONFIG.HOST !== '::1') {
            console.warn('Warning: the bridge is bound beyond loopback. Use firewall rules and an API token before exposing it to a network.');
        }
        if (CONFIG.ALLOWED_ORIGINS.length > 0) console.log(`Allowed browser origins: ${CONFIG.ALLOWED_ORIGINS.join(', ')}`);
        if (CONFIG.API_TOKEN) console.log('API token authentication is enabled.');
    });
}
