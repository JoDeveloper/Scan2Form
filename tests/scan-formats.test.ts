import request from 'supertest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/config';

// Define the mock function globally
const mockSpawnFn = jest.fn();

jest.mock('child_process', () => ({
    spawn: mockSpawnFn
}));

describe('Scan Formats', () => {
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
        mockSpawnFn.mockReset();
        jest.resetModules();
        app = require('../src/bridge-server').app;
    });

    test('NAPS2: POST /scan with format=jpeg generates .jpg extension', async () => {
         // 1. Detection
         mockSpawnFn.mockReturnValueOnce(createMockChild(0));

         // 2. Scan
         mockSpawnFn.mockImplementationOnce((cmd: string, args: string[]) => {
            const child = createMockChild(0);
            const outputFlagIndex = args.indexOf('-o');
            if (outputFlagIndex !== -1 && args[outputFlagIndex + 1]) {
                const outputPath = args[outputFlagIndex + 1];
                fs.writeFileSync(outputPath, "dummy jpeg content");
            }
            return child;
         });

        const res = await request(app)
            .post('/scan')
            .send({ format: 'jpeg' });
        
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('image/jpeg');
        
        const lastCallArgs = mockSpawnFn.mock.calls[1]; // 1 is scan
        const args = lastCallArgs[1];
        const outputPath = args[args.indexOf('-o') + 1];
        expect(outputPath).toMatch(/\.jpg$/);
    });

    test('NAPS2: POST /scan with format=png generates .png extension', async () => {
         // 1. Detection
         mockSpawnFn.mockReturnValueOnce(createMockChild(0));

         // 2. Scan
         mockSpawnFn.mockImplementationOnce((cmd: string, args: string[]) => {
            const child = createMockChild(0);
            const outputFlagIndex = args.indexOf('-o');
            if (outputFlagIndex !== -1 && args[outputFlagIndex + 1]) {
                fs.writeFileSync(args[outputFlagIndex + 1], "dummy png content");
            }
            return child;
         });

        const res = await request(app)
            .post('/scan')
            .send({ format: 'png' });
        
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('image/png');
        
        const lastCallArgs = mockSpawnFn.mock.calls[1];
        const outputPath = lastCallArgs[1][lastCallArgs[1].indexOf('-o') + 1];
        expect(outputPath).toMatch(/\.png$/);
    });

    test('SANE: POST /scan with format=jpeg uses sips conversion', async () => {
        // 1. Fail NAPS2 detection
        mockSpawnFn.mockReturnValueOnce(createMockChild(1));
        // 2. Succeed SANE detection
        mockSpawnFn.mockReturnValueOnce(createMockChild(0));

        // 3. Scan (scanimage)
        mockSpawnFn.mockImplementationOnce((cmd: string, args: string[]) => {
            if (cmd !== 'scanimage') return createMockChild(1);
            
            const child: any = new EventEmitter();
             child.stdout = new EventEmitter();
             child.stdout.pipe = (dest: any) => {
                 dest.write("dummy tiff content");
                 dest.end();
                 return dest;
             };
             child.stderr = new EventEmitter();
             child.kill = jest.fn();
             
             setTimeout(() => {
                 child.emit('close', 0);
             }, 10);
             return child;
        });

        // 4. Convert (sips)
        mockSpawnFn.mockImplementationOnce((cmd: string, args: string[]) => {
            if (cmd === 'sips') {
                const outFlagIndex = args.indexOf('--out');
                if (outFlagIndex !== -1) {
                    fs.writeFileSync(args[outFlagIndex + 1], "dummy jpeg result");
                }
                return createMockChild(0);
            }
            return createMockChild(1);
        });

       const res = await request(app)
           .post('/scan')
           .send({ format: 'jpeg' });
       
       expect(res.status).toBe(200);
       expect(res.header['content-type']).toContain('image/jpeg');
       
       const calls = mockSpawnFn.mock.calls.map((c: any) => c[0]);
       expect(calls[0]).toBe('naps2.console');
       expect(calls[1]).toBe('scanimage');
       expect(calls[2]).toBe('scanimage');
       expect(calls[3]).toBe('sips');
   });
});
