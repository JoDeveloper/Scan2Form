import { ScannerEngine } from './scanner-engine';
import { Device, ScanOptions } from '../types';
import { runCommand } from '../utils';
import { ScanError } from '../errors';
import { CONFIG } from '../config';

export class Naps2Engine implements ScannerEngine {
    name = 'naps2';

    private getDriver(): string {
        if (CONFIG.NAPS2_DRIVER) return CONFIG.NAPS2_DRIVER;
        if (process.platform === 'win32') return 'wia';
        if (process.platform === 'darwin') return 'apple';
        return 'sane';
    }

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
            const driver = this.getDriver();
            const stdout = await runCommand('naps2.console', ['--listdevices', '--driver', driver]);
            return Array.from(new Set(stdout.split('\n')
                .map(line => line.trim())
                .filter(Boolean)))
                .map(name => ({ id: name, name, driver }));
        } catch (e: any) {
            throw new ScanError('DEVICE_LIST_FAILED', 'Failed to list NAPS2 devices', e.message);
        }
    }

    async scan(options: ScanOptions, outputPath: string, signal?: AbortSignal): Promise<void> {
        try {
            const args = ['-o', outputPath, '-v'];
            const hasOverrides = options.dpi !== undefined || options.mode !== undefined;

            if (options.deviceId || hasOverrides) {
                if (!options.deviceId) {
                    throw new ScanError('DEVICE_REQUIRED', 'Select a scanner when overriding scan settings.', null, 400);
                }

                args.push('--noprofile', '--driver', this.getDriver(), '--device', options.deviceId);
                if (options.dpi !== undefined) args.push('--dpi', String(options.dpi));
                if (options.mode !== undefined) args.push('--bitdepth', options.mode === 'bw' ? 'bw' : options.mode);
            }
            
            await runCommand('naps2.console', args, { signal });
        } catch (e: any) {
            if (e instanceof ScanError) throw e;
            throw new ScanError('SCAN_FAILED', 'NAPS2 scan failed', e.message);
        }
    }
}
