import { ScannerEngine } from './scanner-engine';
import { Device, ScanOptions } from '../types';
import { runCommand } from '../utils';
import { ScanError } from '../errors';

export class Naps2Engine implements ScannerEngine {
    name = 'naps2';

    async isAvailable(): Promise<boolean> {
        try {
            await runCommand('naps2.console', ['--help'], 5000);
            return true;
        } catch {
            return false;
        }
    }

    async listDevices(): Promise<Device[]> {
        try {
            const stdout = await runCommand('naps2.console', ['--list']);
            return stdout.split('\n')
                .filter(line => line.trim().length > 0)
                .map(line => ({ name: line.trim() }));
        } catch (e: any) {
            throw new ScanError('DEVICE_LIST_FAILED', 'Failed to list NAPS2 devices', e.message);
        }
    }

    async scan(options: ScanOptions, outputPath: string): Promise<void> {
        try {
            const args = ['-o', outputPath, '-v'];
            // If deviceId is provided, NAPS2 might support it via specific flags or profile, 
            // but for now we stick to default behavior or profile usage if previously configured.
            // If explicit device name selection is needed, NAPS2 usually uses profiles.
            
            await runCommand('naps2.console', args);
        } catch (e: any) {
            throw new ScanError('SCAN_FAILED', 'NAPS2 scan failed', e.message);
        }
    }
}
