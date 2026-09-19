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
        // dist/ is gitignored, so guarantee the served browser bundle exists.
        const esmClientPath = path.join(__dirname, '..', 'dist', 'esm', 'scanner-client.js');
        if (!fs.existsSync(esmClientPath)) {
            fs.mkdirSync(path.dirname(esmClientPath), { recursive: true });
            fs.writeFileSync(esmClientPath, 'export {};\n');
        }
    });

    beforeEach(() => {
        mockSpawnFn.mockReset(); // Clear calls and implementations
        
        // Default implementation to handle unexpected calls without crashing
        mockSpawnFn.mockImplementation((cmd: string, args: string[]) => {
            console.warn(`[UNMOCKED SPAWN] ${cmd} ${args ? args.join(' ') : ''}`);
            return createMockChild(1, "", "Unmocked Spawn Call"); 
        });

        jest.resetModules();
        app = require('../src/bridge-server').createBridgeServer();
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
        expect(res.body.requestId).toBe(res.headers['x-request-id']);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('requires a bearer token when token authentication is configured', async () => {
        const previousToken = process.env.SCAN2FORM_API_TOKEN;
        process.env.SCAN2FORM_API_TOKEN = 'test-bridge-token';

        try {
            jest.resetModules();
            app = require('../src/bridge-server').createBridgeServer();

            const missing = await request(app).get('/health');
            expect(missing.status).toBe(401);
            expect(missing.body.code).toBe('UNAUTHORIZED');
            expect(missing.headers['cache-control']).toBe('no-store');
            expect(mockSpawnFn).not.toHaveBeenCalled();

            mockSpawnFn.mockReset();
            mockSpawnFn.mockImplementationOnce(() => createMockChild(0));
            const authorized = await request(app)
                .get('/health')
                .set('Authorization', 'Bearer test-bridge-token');
            expect(authorized.status).toBe(200);
        } finally {
            if (previousToken === undefined) delete process.env.SCAN2FORM_API_TOKEN;
            else process.env.SCAN2FORM_API_TOKEN = previousToken;
        }
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

    test('answers CORS preflight for an allowed local origin', async () => {
        const res = await request(app)
            .options('/scan')
            .set('Origin', `http://localhost:${CONFIG.PORT}`)
            .set('Access-Control-Request-Method', 'POST');

        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(`http://localhost:${CONFIG.PORT}`);
        expect(res.headers['access-control-allow-methods']).toContain('POST');
        expect(res.headers['access-control-allow-headers']).toContain('Authorization');
        expect(res.headers['vary']).toBe('Origin');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('rejects CORS preflight from an untrusted origin', async () => {
        const res = await request(app)
            .options('/scan')
            .set('Origin', 'https://untrusted.example')
            .set('Access-Control-Request-Method', 'POST');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('rejects a malformed JSON body', async () => {
        const res = await request(app)
            .post('/scan')
            .set('Content-Type', 'application/json')
            .send('{"format":');

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_JSON');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('rejects a JSON body over the configured limit', async () => {
        const oversized = JSON.stringify({ deviceId: 'a'.repeat(CONFIG.JSON_BODY_LIMIT_BYTES) });

        const res = await request(app)
            .post('/scan')
            .set('Content-Type', 'application/json')
            .send(oversized);

        expect(res.status).toBe(413);
        expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('rejects a JSON body that is not an object', async () => {
        const res = await request(app)
            .post('/scan')
            .set('Content-Type', 'application/json')
            .send('[1, 2, 3]');

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_REQUEST');
        expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('serves the example UI and the browser client bundle', async () => {
        const index = await request(app).get('/example/');
        expect(index.status).toBe(200);
        expect(index.header['content-type']).toContain('text/html');
        expect(index.text.toLowerCase()).toContain('<!doctype html>');

        const client = await request(app).get('/dist/esm/scanner-client.js');
        expect(client.status).toBe(200);
        expect(client.header['content-type']).toContain('text/javascript');
        expect(client.header['cache-control']).toContain('max-age');
    });

    test('blocks path traversal attempts against static routes', async () => {
        const encoded = await request(app).get('/example/%2e%2e/package.json');
        expect(encoded.status).toBe(404);

        const separator = await request(app).get('/example/..%2f..%2fpackage.json');
        expect(separator.status).toBe(404);

        const dotfile = await request(app).get('/example/.gitignore');
        expect(dotfile.status).toBe(404);
    });

    test('returns 404 for unknown routes and unsupported methods', async () => {
        const unknown = await request(app).get('/definitely-not-a-route');
        expect(unknown.status).toBe(404);
        expect(unknown.body.code).toBe('NOT_FOUND');

        const wrongMethod = await request(app).put('/scan').send({ format: 'pdf' });
        expect(wrongMethod.status).toBe(404);
    });
});
