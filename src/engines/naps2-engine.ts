import { ScannerEngine, ScanEvent } from './scanner-engine';
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

    async scan(scanId: string, options: ScanOptions, outputPath: string, onEvent: (event: ScanEvent) => void): Promise<void> {
        try {
            const args = ['-o', outputPath, '-v'];
            // If deviceId is provided, NAPS2 might support it via specific flags or profile.
            
            // TODO: In future, parse stdout for progress to emit 'progress' events.
            onEvent({ type: 'progress', scanId, payload: { message: 'Starting scan...', percent: 0 } });

            await runCommand('naps2.console', args);

            // For now, we only support 'complete' after the process finishes.
            onEvent({ type: 'complete', scanId, payload: { path: outputPath } });

        } catch (e: any) {
             onEvent({ type: 'error', scanId, payload: { error: e.message } });
            throw new ScanError('SCAN_FAILED', 'NAPS2 scan failed', e.message);
        }
    }
}
