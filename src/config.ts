import path from 'path';
import { ScanFormat } from './types';

export const CONFIG = {
    PORT: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    HOST: process.env.HOST || '127.0.0.1',
    TEMP_DIR: process.env.TEMP_DIR || path.join(__dirname, 'temp_scans'),
    SCAN_TIMEOUT_MS: process.env.SCAN_TIMEOUT_MS ? parseInt(process.env.SCAN_TIMEOUT_MS) : 60000,
    ALLOWED_FORMATS: ['pdf', 'jpg', 'jpeg', 'png'] as ScanFormat[],
};
