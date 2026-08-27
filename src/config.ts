import path from 'path';
import { ScanFormat } from './types';

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOrigins(value: string | undefined): string[] {
    return (value || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
        .flatMap(origin => {
            try {
                const parsed = new URL(origin);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
                    return [];
                }
                return [parsed.origin];
            } catch {
                return [];
            }
        });
}

export const CONFIG = {
    VERSION: '1.4.0',
    PORT: parsePositiveInteger(process.env.PORT, 3000),
    HOST: process.env.HOST || '127.0.0.1',
    TEMP_DIR: path.resolve(process.env.TEMP_DIR || path.join(__dirname, 'temp_scans')),
    SCAN_TIMEOUT_MS: parsePositiveInteger(process.env.SCAN_TIMEOUT_MS, 60000),
    ENGINE_CACHE_TTL_MS: parsePositiveInteger(process.env.ENGINE_CACHE_TTL_MS, 30000),
    TEMP_FILE_MAX_AGE_MS: parsePositiveInteger(process.env.TEMP_FILE_MAX_AGE_MS, 2 * 60 * 60 * 1000),
    MAX_COMMAND_OUTPUT_BYTES: parsePositiveInteger(process.env.MAX_COMMAND_OUTPUT_BYTES, 1024 * 1024),
    MAX_SCAN_BYTES: parsePositiveInteger(process.env.MAX_SCAN_BYTES, 100 * 1024 * 1024),
    MAX_DEVICE_ID_LENGTH: 512,
    JSON_BODY_LIMIT: '16kb',
    DEVICE_CACHE_TTL_MS: parsePositiveInteger(process.env.DEVICE_CACHE_TTL_MS, 10000),
    MAX_SCAN_REQUESTS_PER_WINDOW: parsePositiveInteger(process.env.MAX_SCAN_REQUESTS_PER_WINDOW, 6),
    RATE_LIMIT_WINDOW_MS: parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    ALLOWED_ORIGINS: parseOrigins(process.env.SCAN2FORM_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS),
    API_TOKEN: (process.env.SCAN2FORM_API_TOKEN || '').trim() || null,
    NAPS2_DRIVER: (process.env.NAPS2_DRIVER || '').trim(),
    ALLOWED_FORMATS: ['pdf', 'jpg', 'jpeg', 'png'] as ScanFormat[],
};
