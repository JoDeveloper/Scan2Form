import { spawn } from 'child_process';
import { CONFIG } from './config';

export function runCommand(command: string, args: string[], timeoutMs: number = CONFIG.SCAN_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
        }, timeoutMs);

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `Command failed with code ${code}`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
