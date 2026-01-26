import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ScannerEngine, ScanEvent } from './scanner-engine';
import { Device, ScanOptions } from '../types';
import { runCommand } from '../utils';
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
            return stdout.split('\n')
                .filter(line => line.includes('is a'))
                .map(line => {
                    const name = line.replace('device `', '').replace(`'`, '');
                    return { name };
                });
        } catch (e: any) {
            throw new ScanError('DEVICE_LIST_FAILED', 'Failed to list SANE devices', e.message);
        }
    }

    async scan(scanId: string, options: ScanOptions, outputPath: string, onEvent: (event: ScanEvent) => void): Promise<void> {
        const tempTiffPath = outputPath.replace(/\.\w+$/, '.tiff');
        
        try {
            // SANE Scan
            const args = ['--format=tiff', '--mode', 'Color', '--resolution', '300'];
            if (options.deviceId) {
                 args.push('-d', options.deviceId); 
            }

            onEvent({ type: 'progress', scanId, payload: { message: 'Starting SANE scan...', percent: 0 } });

            await new Promise<void>((resolve, reject) => {
                const fileStream = fs.createWriteStream(tempTiffPath);
                const child = spawn('scanimage', args);
                
                child.stdout.pipe(fileStream);
                
                let stderr = '';
                child.stderr.on('data', d => stderr += d);
                
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(stderr || `SANE failed with code ${code}`));
                });
                
                child.on('error', reject);
            });

            onEvent({ type: 'progress', scanId, payload: { message: 'Converting file...', percent: 80 } });

            // Conversion
            let sipsFormat = options.format;
            if (options.format === 'jpg') sipsFormat = 'jpeg';
            
            await runCommand('sips', ['-s', 'format', sipsFormat, tempTiffPath, '--out', outputPath]);

            onEvent({ type: 'complete', scanId, payload: { path: outputPath } });

        } catch (e: any) {
            onEvent({ type: 'error', scanId, payload: { error: e.message } });
            throw new ScanError('SCAN_FAILED', 'SANE scan failed', e.message);
        } finally {
             if (fs.existsSync(tempTiffPath)) fs.unlinkSync(tempTiffPath);
        }
    }
}
