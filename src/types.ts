export interface Device {
    id?: string;
    name: string;
    driver?: string;
}

export type ScanFormat = 'pdf' | 'jpg' | 'jpeg' | 'png';
export type ScanMode = 'color' | 'gray' | 'bw';

export interface ScanOptions {
    format: ScanFormat;
    deviceId?: string;
    dpi?: number;
    mode?: ScanMode;
}

export interface ScanClientOptions {
    bridgeUrl?: string;
    requestTimeoutMs?: number;
    token?: string;
    fetch?: typeof fetch;
}

export interface ScanRequestOptions {
    format?: ScanFormat;
    deviceId?: string;
    dpi?: number;
    mode?: ScanMode;
    signal?: AbortSignal;
}

export interface ScanResult {
    success: boolean;
    file?: File;
    error?: string;
}
