import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ScannerEngine } from './scanner-engine';
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

    async scan(options: ScanOptions, outputPath: string): Promise<void> {
        const tempTiffPath = outputPath.replace(/\.\w+$/, '.tiff');
        
        try {
            // SANE Scan
            const args = ['--format=tiff', '--mode', 'Color', '--resolution', '300'];
            if (options.deviceId) {
                 args.push('-d', options.deviceId); 
                 // Note: Device ID handling needs care given the string format, 
                 // but for SANE 'deviceId' is usually the name/address.
            }

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

            // Conversion
            let sipsFormat = options.format;
            if (options.format === 'jpg') sipsFormat = 'jpeg';
            
            await runCommand('sips', ['-s', 'format', sipsFormat, tempTiffPath, '--out', outputPath]);

        } catch (e: any) {
            throw new ScanError('SCAN_FAILED', 'SANE scan failed', e.message);
        } finally {
             if (fs.existsSync(tempTiffPath)) fs.unlinkSync(tempTiffPath);
        }
    }
}
