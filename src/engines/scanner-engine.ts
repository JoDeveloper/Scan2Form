import { Device, ScanOptions } from '../types';

export interface ScannerEngine {
    name: string;
    isAvailable(): Promise<boolean>;
    listDevices(): Promise<Device[]>;
    scan(options: ScanOptions, outputPath: string): Promise<void>;
}
