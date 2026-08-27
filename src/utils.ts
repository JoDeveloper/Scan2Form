import { spawn } from 'child_process';
import fs from 'fs';
import { CONFIG } from './config';

export interface CommandOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
}

interface ResolvedCommandOptions {
    timeoutMs: number;
    signal?: AbortSignal;
    maxOutputBytes: number;
}

export class CommandAbortedError extends Error {
    code = 'ABORT_ERR';

    constructor() {
        super('Command aborted');
        this.name = 'CommandAbortedError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

function resolveOptions(timeoutOrOptions: number | CommandOptions): ResolvedCommandOptions {
    if (typeof timeoutOrOptions === 'number') {
        return {
            timeoutMs: timeoutOrOptions,
            signal: undefined,
            maxOutputBytes: CONFIG.MAX_COMMAND_OUTPUT_BYTES,
        };
    }

    return {
        timeoutMs: timeoutOrOptions.timeoutMs ?? CONFIG.SCAN_TIMEOUT_MS,
        signal: timeoutOrOptions.signal,
        maxOutputBytes: timeoutOrOptions.maxOutputBytes ?? CONFIG.MAX_COMMAND_OUTPUT_BYTES,
    };
}

function stopChild(child: ReturnType<typeof spawn> | undefined): void {
    if (!child || child.killed) return;
    try {
        child.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // The process may have exited while the grace period elapsed.
            }
        }, 250);
        forceKillTimer.unref?.();
    } catch {
        // The process may have exited between the state check and kill().
    }
}

function withSignal(timeoutOrOptions: number | CommandOptions, signal?: AbortSignal): number | CommandOptions {
    if (!signal) return timeoutOrOptions;
    if (typeof timeoutOrOptions === 'number') return { timeoutMs: timeoutOrOptions, signal };
    return { ...timeoutOrOptions, signal };
}

export function runCommand(
    command: string,
    args: string[],
    timeoutOrOptions: number | CommandOptions = CONFIG.SCAN_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<string> {
    const options = resolveOptions(withSignal(timeoutOrOptions, signal));

    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new CommandAbortedError());
            return;
        }

        let child: ReturnType<typeof spawn>;
        try {
            // Never invoke a shell. Scanner/device values remain individual arguments.
            child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            reject(error);
            return;
        }

        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = () => fail(new CommandAbortedError());
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            stopChild(child);
            reject(error);
        };
        const capture = (stream: 'stdout' | 'stderr', data: Buffer | string) => {
            if (settled) return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            outputBytes += chunk.byteLength;
            if (outputBytes > options.maxOutputBytes) {
                fail(new Error('Command output exceeded the configured limit'));
                return;
            }
            if (stream === 'stdout') stdout += chunk.toString();
            else stderr += chunk.toString();
        };

        timer = setTimeout(() => fail(new Error(`Command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout!.on('data', (data: Buffer | string) => capture('stdout', data));
        child.stderr!.on('data', (data: Buffer | string) => capture('stderr', data));
        child.once('close', (code) => {
            if (settled) return;
            if (code === 0) {
                settled = true;
                cleanup();
                resolve(stdout);
            } else {
                fail(new Error(stderr.trim() || `Command failed with code ${code}`));
            }
        });
        child.once('error', (error) => fail(error));
    });
}

export function runCommandToFile(
    command: string,
    args: string[],
    outputPath: string,
    timeoutOrOptions: number | CommandOptions = CONFIG.SCAN_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<void> {
    const mergedOptions = withSignal(timeoutOrOptions, signal);
    const options = resolveOptions(typeof mergedOptions === 'number'
        ? { timeoutMs: mergedOptions, maxOutputBytes: CONFIG.MAX_SCAN_BYTES }
        : { ...mergedOptions, maxOutputBytes: mergedOptions.maxOutputBytes ?? CONFIG.MAX_SCAN_BYTES });

    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new CommandAbortedError());
            return;
        }

        const fileStream = fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
        let child: ReturnType<typeof spawn> | undefined;
        let childClosed = false;
        let fileFinished = false;
        let exitCode: number | null = null;
        let stderr = '';
        let stderrBytes = 0;
        let outputBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = () => fail(new CommandAbortedError());
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            stopChild(child);
            fileStream.destroy();
            reject(error);
        };
        const maybeFinish = () => {
            if (settled || !childClosed || !fileFinished) return;
            settled = true;
            cleanup();
            if (exitCode === 0) resolve();
            else reject(new Error(stderr.trim() || `Command failed with code ${exitCode}`));
        };

        try {
            // Never invoke a shell. Scanner/device values remain individual arguments.
            child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            fileStream.destroy();
            reject(error);
            return;
        }

        timer = setTimeout(() => fail(new Error(`Command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child!.stdout!.on('data', (data: Buffer | string) => {
            if (settled) return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            outputBytes += chunk.byteLength;
            if (outputBytes > options.maxOutputBytes) fail(new Error('Command output exceeded the configured limit'));
        });
        child!.stderr!.on('data', (data: Buffer | string) => {
            if (settled) return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            stderrBytes += chunk.byteLength;
            if (stderrBytes > options.maxOutputBytes) fail(new Error('Command output exceeded the configured limit'));
            else stderr += chunk.toString();
        });
        child!.stdout!.pipe(fileStream);
        child!.once('close', (code) => {
            if (settled) return;
            childClosed = true;
            exitCode = code;
            maybeFinish();
        });
        child!.once('error', (error) => fail(error));
        fileStream.once('finish', () => {
            if (settled) return;
            fileFinished = true;
            maybeFinish();
        });
        fileStream.once('error', (error) => fail(error));
    });
}
