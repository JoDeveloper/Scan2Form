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

    const createMockChild = (code = 0, stdoutStr = '', stderrStr = '', delay = 10) => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = jest.fn();
        
        setTimeout(() => {
            if (stdoutStr) child.stdout.emit('data', stdoutStr);
            if (stderrStr) child.stderr.emit('data', stderrStr);
            child.emit('close', code);
        }, delay);
        
        return child;
    };

    beforeAll(() => {
        if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR);
    });

    beforeEach(() => {
        mockSpawnFn.mockReset(); // Clear calls and implementations
        jest.resetModules();
        app = require('../src/bridge-server').app;
    });

    test('GET /health returns 200 and status ok', async () => {
        // NAPS2 check success for getEngine
        mockSpawnFn.mockReturnValueOnce(createMockChild(0, "", "")); 
        
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
    });

    test('POST /scan success flow', async () => {
        // 1. getEngine -> NAPS2 check
        mockSpawnFn.mockReturnValueOnce(createMockChild(0));
        
        // 2. scan -> NAPS2 scan command
        mockSpawnFn.mockImplementationOnce((cmd: string, args: string[]) => {
            const child = createMockChild(0);
            
            // Write file synchronously
            const outputFlagIndex = args.indexOf('-o');
            if (outputFlagIndex !== -1 && args[outputFlagIndex + 1]) {
                const outputPath = args[outputFlagIndex + 1];
                fs.writeFileSync(outputPath, "dummy pdf content");
            }
            return child;
        });

        const res = await request(app)
            .post('/scan')
            .send({ format: 'pdf' });
        
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('application/pdf');
    });
});
