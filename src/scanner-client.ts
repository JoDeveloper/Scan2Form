import {
    Device,
    ScanClientOptions,
    ScanFormat,
    ScanMode,
    ScanRequestOptions,
    ScanResult,
} from './types';

export type { Device, ScanClientOptions, ScanFormat, ScanMode, ScanRequestOptions, ScanResult } from './types';

export interface BridgeHealth {
    status: 'ok' | 'error';
    engine?: string;
    version?: string;
    formats?: ScanFormat[];
    busy?: boolean;
}

export interface HealthResult {
    success: boolean;
    health?: BridgeHealth;
    error?: string;
}

export class ScanClientError extends Error {
    constructor(
        message: string,
        public code = 'CLIENT_ERROR',
        public status?: number,
    ) {
        super(message);
        this.name = 'ScanClientError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MIME_TYPES: Record<string, string> = {
    'application/pdf': 'application/pdf',
    'image/jpeg': 'image/jpeg',
    'image/png': 'image/png',
};

export class Scan2Form {
    private readonly bridgeUrl: string;
    private readonly requestTimeoutMs: number;
    private readonly token?: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: string | ScanClientOptions = {}) {
        const config = typeof options === 'string' ? { bridgeUrl: options } : options;
        const bridgeUrl = config.bridgeUrl || DEFAULT_BRIDGE_URL;
        const parsedUrl = new URL(bridgeUrl);

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Bridge URL must use http or https');
        }

        parsedUrl.search = '';
        parsedUrl.hash = '';
        this.bridgeUrl = parsedUrl.toString().replace(/\/$/, '');
        this.requestTimeoutMs = Number.isFinite(config.requestTimeoutMs) && (config.requestTimeoutMs || 0) > 0
            ? Math.min(config.requestTimeoutMs as number, MAX_TIMEOUT_MS)
            : DEFAULT_TIMEOUT_MS;
        this.token = config.token;

        const defaultFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
        if (!config.fetch && !defaultFetch) throw new Error('Fetch is not available in this environment');
        this.fetchImpl = config.fetch || defaultFetch as typeof fetch;
    }

    private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.requestTimeoutMs);
        const abortRequest = () => controller.abort();

        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', abortRequest, { once: true });
        }

        const headers = createRequestHeaders(init.headers, this.token);

        try {
            return await this.fetchImpl(`${this.bridgeUrl}${path}`, {
                ...init,
                cache: 'no-store',
                credentials: 'omit',
                headers,
                signal: controller.signal,
            });
        } catch (error: any) {
            if (timedOut) throw new ScanClientError('Bridge request timed out', 'TIMEOUT');
            if (signal?.aborted) throw new ScanClientError('Request cancelled', 'CANCELLED');
            throw new ScanClientError(error?.message || 'Network error', 'NETWORK_ERROR');
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abortRequest);
        }
    }

    private async readError(response: Response): Promise<ScanClientError> {
        const data = await response.json().catch(() => ({}));
        const message = typeof data.error === 'string'
            ? data.error
            : typeof data.message === 'string'
                ? data.message
                : response.statusText || 'Bridge request failed';
        return new ScanClientError(message, typeof data.code === 'string' ? data.code : 'BRIDGE_ERROR', response.status);
    }

    async getHealth(): Promise<HealthResult> {
        try {
            const response = await this.request('/health');
            const data = await response.json().catch(() => ({})) as Partial<BridgeHealth> & { error?: unknown; code?: unknown };
            if (!response.ok) {
                const message = typeof data.error === 'string' ? data.error : response.statusText || 'Bridge request failed';
                throw new ScanClientError(message, typeof data.code === 'string' ? data.code : 'BRIDGE_ERROR', response.status);
            }
            return {
                success: true,
                health: {
                    status: data.status === 'error' ? 'error' : 'ok',
                    engine: typeof data.engine === 'string' ? data.engine : undefined,
                    version: typeof data.version === 'string' ? data.version : undefined,
                    formats: Array.isArray(data.formats) ? data.formats as ScanFormat[] : undefined,
                    busy: Boolean(data.busy),
                },
            };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    async isAvailable(): Promise<{ success: boolean; error?: string; engine?: string; busy?: boolean }> {
        const result = await this.getHealth();
        return {
            success: result.success,
            error: result.error,
            engine: result.health?.engine,
            busy: result.health?.busy,
        };
    }

    async listDevices(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ devices: Device[]; error?: string }> {
        try {
            const response = await this.request(options.refresh ? '/devices?refresh=1' : '/devices', {}, options.signal);
            if (!response.ok) throw await this.readError(response);
            const data = await response.json() as { devices?: unknown };
            return { devices: normalizeDevices(data.devices) };
        } catch (error) {
            return { devices: [], error: errorMessage(error) };
        }
    }

    /** Backwards-compatible device names for versions before listDevices(). */
    async getDevices(): Promise<{ devices: string[]; error?: string }> {
        const result = await this.listDevices();
        return { devices: result.devices.map(device => device.name), error: result.error };
    }

    async scan(options: ScanRequestOptions = {}): Promise<ScanResult> {
        try {
            const format = options.format || 'pdf';
            const body: Record<string, string | number> = { format };
            if (options.deviceId) body.deviceId = options.deviceId;
            if (options.dpi !== undefined) body.dpi = options.dpi;
            if (options.mode) body.mode = options.mode;

            const response = await this.request('/scan', {
                method: 'POST',
                headers: {
                    Accept: 'application/pdf, image/jpeg, image/png',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, options.signal);

            if (!response.ok) throw await this.readError(response);

            const blob = await response.blob();
            if (blob.size === 0) throw new ScanClientError('Bridge returned an empty scan file', 'EMPTY_RESULT');

            const responseMime = (response.headers.get('content-type') || blob.type || '')
                .split(';', 1)[0]
                .trim()
                .toLowerCase();
            const requestedMime = formatToMime(format);
            const mimeType = MIME_TYPES[responseMime] || (responseMime === 'application/octet-stream' || !responseMime ? requestedMime : '');
            if (!mimeType) throw new ScanClientError('Bridge returned an unsupported file type', 'UNEXPECTED_CONTENT_TYPE');

            const extension = extensionForMime(mimeType, format);
            const file = createScanFile(blob, `scanned_doc_${Date.now()}.${extension}`, mimeType);
            return { success: true, file };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    async scanToInput(inputId: string, options?: ScanRequestOptions): Promise<ScanResult> {
        if (typeof document === 'undefined') throw new Error('scanToInput requires a browser document');
        const element = document.getElementById(inputId);
        if (!element || element.tagName !== 'INPUT' || (element as HTMLInputElement).type !== 'file') {
            throw new Error('A file input element was not found');
        }

        const result = await this.scan(options);
        if (!result.success || !result.file) return result;

        try {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(result.file);
            (element as HTMLInputElement).files = dataTransfer.files;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return result;
        } catch (error) {
            return { success: false, error: errorMessage(error) || 'Unable to attach the scanned file' };
        }
    }
}

function normalizeDevices(value: unknown): Device[] {
    if (!Array.isArray(value)) return [];

    const devices: Device[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const device = typeof item === 'string'
            ? { id: item, name: item }
            : item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
                ? {
                    id: typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : undefined,
                    name: (item as { name: string }).name,
                    driver: typeof (item as { driver?: unknown }).driver === 'string' ? (item as { driver: string }).driver : undefined,
                }
                : null;
        if (!device || !device.name || seen.has(device.name)) continue;
        seen.add(device.name);
        devices.push(device);
    }
    return devices;
}

function formatToMime(format: ScanFormat): string {
    if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
    if (format === 'png') return 'image/png';
    return 'application/pdf';
}

function extensionForMime(mimeType: string, requestedFormat: ScanFormat): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/png') return 'png';
    return requestedFormat === 'jpeg' ? 'jpg' : 'pdf';
}

function createScanFile(blob: Blob, name: string, mimeType: string): File {
    if (typeof globalThis.File === 'function') {
        return new globalThis.File([blob], name, { type: mimeType });
    }

    // Node versions without a global File still provide Blob. Decorating the
    // blob keeps the client usable with injected fetch implementations and in
    // server-side tests; browsers always take the native File path above.
    try {
        Object.defineProperties(blob, {
            name: { configurable: true, enumerable: true, value: name },
            lastModified: { configurable: true, enumerable: true, value: Date.now() },
        });
    } catch {
        // A non-extensible Blob is still the best available file payload.
    }
    return blob as File;
}

function createRequestHeaders(initHeaders: HeadersInit | undefined, token?: string): HeadersInit {
    if (typeof globalThis.Headers === 'function') {
        const headers = new globalThis.Headers(initHeaders);
        if (!headers.has('Accept')) headers.set('Accept', 'application/json');
        if (token) headers.set('Authorization', `Bearer ${token}`);
        return headers;
    }

    const headers: Record<string, string> = {};
    if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders) headers[key] = value;
    } else if (initHeaders && typeof (initHeaders as Headers).forEach === 'function') {
        (initHeaders as Headers).forEach((value, key) => { headers[key] = value; });
    } else if (initHeaders) {
        Object.assign(headers, initHeaders);
    }

    const hasHeader = (name: string) => Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());
    if (!hasHeader('Accept')) headers.Accept = 'application/json';
    if (token) {
        const authorizationKey = Object.keys(headers).find(key => key.toLowerCase() === 'authorization');
        headers[authorizationKey || 'Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown scan error';
}
