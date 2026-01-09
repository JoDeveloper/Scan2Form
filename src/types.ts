export interface Device {
    id?: string;
    name: string;
}

export type ScanFormat = 'pdf' | 'jpg' | 'jpeg' | 'png';

export interface ScanOptions {
    format: ScanFormat;
    deviceId?: string;
}
