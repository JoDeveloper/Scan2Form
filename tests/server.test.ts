import request from 'supertest';
import { app } from '../src/bridge-server';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

// Mock child_process.exec
jest.mock('child_process', () => ({
    exec: jest.fn()
}));

describe('Bridge Server API', () => {
    const TEMP_DIR = path.join(__dirname, '../src/temp_scans');

    beforeAll(() => {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('GET /health returns 200 and status ok', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ status: "ok" }));
    });

    test('POST /scan tries to execute naps2 and download file', async () => {
         // Mock exec to simulate success app.post('/scan') logic
         (exec as unknown as jest.Mock).mockImplementation((cmd, callback) => {
             // Extract output path from command string: ... -o "path/to/file" ...
             const match = cmd.match(/-o "(.*?)"/);
             if (match && match[1]) {
                 const outputPath = match[1];
                 // Create dummy PDF file
                 fs.writeFileSync(outputPath, "dummy pdf content");
             }
             
             // callback(error, stdout, stderr)
             callback(null, "Scanning done", "");
         });

        const res = await request(app).post('/scan');
        
        expect(res.status).toBe(200);
        // Verify exec was called
        expect(exec).toHaveBeenCalled();
        expect((exec as unknown as jest.Mock).mock.calls[0][0]).toContain('naps2.console');
        
        // Verify file content (downloaded) if possible, or just headers
        expect(res.header['content-type']).toContain('application/pdf');
    });
});

