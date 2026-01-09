
import request from 'supertest';
import { app } from '../src/bridge-server';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

// Mock child_process.exec
jest.mock('child_process', () => ({
    exec: jest.fn()
}));

describe('Scan Formats', () => {
    const TEMP_DIR = path.join(__dirname, '../src/temp_scans');

    beforeAll(() => {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Test NAPS2 Image Support
    test('NAPS2: POST /scan with format=jpeg generates .jpg extension', async () => {
         // 1. Setup mock for NAPS2 detection (success) and Scan (success)
         (exec as unknown as jest.Mock).mockImplementation((cmd, callback) => {
             // 1a. Detection check
             if (cmd.includes('naps2.console --help')) {
                 return callback(null, "", ""); // Success -> NAPS2 detected
             }

             // 1b. Scan command
             if (cmd.includes('naps2.console') && cmd.includes('-o')) {
                 // Verify extension is correct
                 const match = cmd.match(/-o "(.*?)"/);
                 if (match && match[1]) {
                     const outputPath = match[1];
                     // Just creating a dummy file so the server can send it back
                     fs.writeFileSync(outputPath, "dummy jpeg content");
                     return callback(null, "Done", "");
                 }
             }
             
             // Fallback
             callback(new Error(`Unknown cmd: ${cmd}`), "", "Error");
         });

        const res = await request(app)
            .post('/scan')
            .send({ format: 'jpeg' });
        
        expect(res.status).toBe(200);
        // Verify Content-Type inferred from extension
        expect(res.header['content-type']).toContain('image/jpeg');
        
        // Verify Command structure
        const lastCallArgs = (exec as unknown as jest.Mock).mock.calls;
        // Find the scan call
        const scanCall = lastCallArgs.find(args => args[0].includes('-o '));
        expect(scanCall[0]).toMatch(/\.jpg"/); // Should end in .jpg"
    });

    test('NAPS2: POST /scan with format=png generates .png extension', async () => {
         (exec as unknown as jest.Mock).mockImplementation((cmd, callback) => {
             if (cmd.includes('naps2.console --help')) return callback(null, "", "");
             
             if (cmd.includes('naps2.console')) {
                 const match = cmd.match(/-o "(.*?)"/);
                 if (match && match[1]) {
                     fs.writeFileSync(match[1], "dummy png content");
                     return callback(null, "Done", "");
                 }
             }
             callback(null, "", "");
         });

        const res = await request(app)
            .post('/scan')
            .send({ format: 'png' });
        
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('image/png');
        
        const lastCallArgs = (exec as unknown as jest.Mock).mock.calls;
        const scanCall = lastCallArgs.find(args => args[0].includes('-o '));
        expect(scanCall[0]).toMatch(/\.png"/);
    });

    // Test SANE + SIPS Support (Simulate Mac)
    test('SANE: POST /scan with format=jpeg uses sips conversion', async () => {
        (exec as unknown as jest.Mock).mockImplementation((cmd, callback) => {
             // 1. Fail NAPS2 detection
             if (cmd.includes('naps2.console --help')) {
                 return callback(new Error("Not found"), "", ""); 
             }
             // 2. Succeed SANE detection
             if (cmd.includes('scanimage --version')) {
                 return callback(null, "version 1.0", "");
             }

             // 3. Handle Scan (scanimage)
             if (cmd.includes('scanimage --format=tiff')) {
                 const match = cmd.match(/> "(.*?)"/);
                 if(match && match[1]) {
                     fs.writeFileSync(match[1], "dummy tiff"); // create temp tiff
                 }
                 return callback(null, "", "");
             }

             // 4. Handle Conversion (sips)
             if (cmd.includes('sips -s format')) {
                 // Check if format is jpeg
                 if (!cmd.includes('sips -s format jpeg')) {
                      return callback(new Error("Wrong sips format"), "", "");
                 }

                 const match = cmd.match(/--out "(.*?)"/);
                 if (match && match[1]) {
                     fs.writeFileSync(match[1], "dummy jpeg result");
                     return callback(null, "", "");
                 }
             }
             
             callback(new Error(`Unknown: ${cmd}`));
        });

       const res = await request(app)
           .post('/scan')
           .send({ format: 'jpeg' });
       
       expect(res.status).toBe(200);
       expect(res.header['content-type']).toContain('image/jpeg'); // express.sendFile sets this based on ext
       
       // Verify sips called
       const calls = (exec as unknown as jest.Mock).mock.calls.map(c => c[0]);
       expect(calls.some(c => c.includes('scanimage --format=tiff'))).toBe(true);
       expect(calls.some(c => c.includes('sips -s format jpeg'))).toBe(true);
   });
});
