import fs from 'fs';
import { ScannerEngine } from './scanner-engine';
import { Device, ScanOptions } from '../types';
import { CommandAbortedError, runCommand, runCommandToFile } from '../utils';
import { ScanError } from '../errors';
import { CONFIG } from '../config';

export class SaneEngine implements ScannerEngine {
    name = 'sane';

    async isAvailable(): Promise<boolean> {
        try {
            await runCommand('scanimage', ['--version'], 5000);
            return true;
        } catch {
            return false;
        }
    }

    async listDevices(): Promise<Device[]> {
        try {
            const stdout = await runCommand('scanimage', ['-L']);
            return Array.from(new Set(stdout.split('\n')
                .filter(line => line.includes('is a'))
                .map(line => line.replace(/^device `/, '').replace(/'.*$/, '').trim())
                .filter(Boolean)))
                .map(name => ({ id: name, name, driver: 'sane' }));
        } catch (e: any) {
            throw new ScanError('DEVICE_LIST_FAILED', 'Failed to list SANE devices', e.message);
        }
    }

    async scan(options: ScanOptions, outputPath: string, signal?: AbortSignal): Promise<void> {
        const tempTiffPath = outputPath.replace(/\.\w+$/, '.tiff');

        try {
            const mode = options.mode === 'gray' ? 'Gray' : options.mode === 'bw' ? 'Lineart' : 'Color';
            const dpi = options.dpi ?? 300;
            const args = ['--format=tiff', '--mode', mode, '--resolution', String(dpi)];
            if (options.deviceId) args.push('-d', options.deviceId);

            await runCommandToFile('scanimage', args, tempTiffPath, {
                signal,
                maxOutputBytes: CONFIG.MAX_SCAN_BYTES,
            });

            let sipsFormat = options.format;
            if (options.format === 'jpg') sipsFormat = 'jpeg';
            await runCommand('sips', ['-s', 'format', sipsFormat, tempTiffPath, '--out', outputPath], { signal });
        } catch (e: any) {
            if (e instanceof CommandAbortedError) {
                throw new ScanError('SCAN_ABORTED', 'Scan cancelled.', null, 499);
            }
            if (e instanceof ScanError) throw e;
            throw new ScanError('SCAN_FAILED', 'SANE scan failed', e.message);
        } finally {
            if (fs.existsSync(tempTiffPath)) {
                try {
                    fs.unlinkSync(tempTiffPath);
                } catch {
                    // The bridge removes the final scan file separately.
                }
            }
        }
    }
}
