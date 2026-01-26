import { Device, ScanOptions } from '../types';

export type ScanEventType = 'progress' | 'page' | 'complete' | 'error';

export interface ScanEvent {
    type: ScanEventType;
    scanId: string;
    payload?: any;
}

export interface ScannerEngine {
    name: string;
    isAvailable(): Promise<boolean>;
    listDevices(): Promise<Device[]>;
    scan(scanId: string, options: ScanOptions, outputPath: string, onEvent: (event: ScanEvent) => void): Promise<void>;
}
