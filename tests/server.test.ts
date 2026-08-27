import request from 'supertest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/config';

// Define the mock function globally so it persists across module resets
const mockSpawnFn = jest.fn();

jest.mock('child_process', () => ({
    spawn: mockSpawnFn
}));

describe('Bridge Server API', () => {
    let app: any;

    const createMockChild = (code = 0, stdoutStr = '', stderrStr = '', delay = 100) => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        // Add pipe to stdout for SaneEngine compatibility
        child.stdout.pipe = (dest: any) => child.stdout.on('data', (d: any) => dest.write(d));
        
        child.stderr = new EventEmitter();
        child.kill = jest.fn();
        
        setTimeout(() => {
            if (stdoutStr) child.stdout.emit('data', stdoutStr);
            if (stderrStr) child.stderr.emit('data', stderrStr);
            child.emit('close', code);
        }, delay);
        
        return child;
    };

    // Helper to ensure output file is written if -o is present
    const mockScanWithFileCheck = (content: string) => (cmd: string, args: string[]) => {
        const child = createMockChild(0);
        const outputFlagIndex = args.indexOf('-o');
        if (outputFlagIndex !== -1 && args[outputFlagIndex + 1]) {
            const outputPath = args[outputFlagIndex + 1];
            try {
                fs.writeFileSync(outputPath, content);
            } catch (err) {
                 console.error("Mock Write Failed:", err);
            }
        }
        return child;
    };

    beforeAll(() => {
        if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR);
    });

    beforeEach(() => {
        mockSpawnFn.mockReset(); // Clear calls and implementations
        
        // Default implementation to handle unexpected calls without crashing
        mockSpawnFn.mockImplementation((cmd: string, args: string[]) => {
            console.warn(`[UNMOCKED SPAWN] ${cmd} ${args ? args.join(' ') : ''}`);
            return createMockChild(1, "", "Unmocked Spawn Call"); 
        });

        jest.resetModules();
        app = require('../src/bridge-server').app;
    });

    test('GET /health returns 200 and status ok', async () => {
        // NAPS2 check success for getEngine
        mockSpawnFn.mockImplementationOnce(() => createMockChild(0, "", "")); 
        
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    test('rejects an untrusted browser origin before engine discovery', async () => {
        const res = await request(app)
            .get('/health')
            .set('Origin', 'https://untrusted.example');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('rejects unsafe scan options before invoking a scanner', async () => {
        const invalidFormat = await request(app)
            .post('/scan')
            .send({ format: 'exe' });
        expect(invalidFormat.status).toBe(400);
        expect(invalidFormat.body.code).toBe('INVALID_FORMAT');

        const invalidDevice = await request(app)
            .post('/scan')
            .send({ format: 'pdf', deviceId: 'scanner\nname' });
        expect(invalidDevice.status).toBe(400);
        expect(invalidDevice.body.code).toBe('INVALID_DEVICE_ID');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('returns normalized devices and caches repeated discovery', async () => {
        mockSpawnFn.mockImplementationOnce(() => createMockChild(0));
        mockSpawnFn.mockImplementationOnce(() => createMockChild(0, 'Scanner One\nScanner One\n'));

        const first = await request(app).get('/devices');
        const second = await request(app).get('/devices');

        expect(first.status).toBe(200);
        expect(first.body.devices).toEqual([expect.objectContaining({ id: 'Scanner One', name: 'Scanner One' })]);
        expect(second.body.devices).toEqual(first.body.devices);
        expect(mockSpawnFn).toHaveBeenCalledTimes(2);
    });

    test('passes validated device and quality settings to NAPS2', async () => {
        mockSpawnFn.mockImplementationOnce(() => createMockChild(0));
        mockSpawnFn.mockImplementationOnce(mockScanWithFileCheck('dummy png content'));

        const res = await request(app)
            .post('/scan')
            .send({ format: 'png', deviceId: 'scanner-1', dpi: 600, mode: 'gray' });

        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('image/png');
        const args = mockSpawnFn.mock.calls[1][1] as string[];
        expect(args).toEqual(expect.arrayContaining(['--noprofile', '--device', 'scanner-1', '--dpi', '600', '--bitdepth', 'gray']));
    });

    test('POST /scan success flow', async () => {
        // 1. getEngine -> NAPS2 check
        mockSpawnFn.mockImplementationOnce(() => createMockChild(0));
        
        // 2. scan -> NAPS2 scan command
        mockSpawnFn.mockImplementationOnce(mockScanWithFileCheck("dummy pdf content"));

        const res = await request(app)
            .post('/scan')
            .send({ format: 'pdf' });
        
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('application/pdf');
    }, 10000); 
});
