import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = 3000; // Localhost only

// Rule 9.1: Bind only to localhost (enforced in listen)
// Rule 9.3: Secure temp directory
const TEMP_DIR = path.join(__dirname, 'temp_scans');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

app.use(cors()); // Allow browser to hit localhost
app.use(express.json());

// Rule 4.2: Health Check
app.get('/health', (req, res) => {
    res.json({ status: "ok", engine: "NAPS2-Wrapper", version: "1.0.0" });
});

// Rule 4.2: Scan Endpoint
app.post('/scan', async (req, res) => {
    const scanId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `scan_${scanId}.pdf`);
    
    // Command to scan using NAPS2 Console (Universal Driver)
    // --noprofile: uses default settings
    // --output: specifies destination
    // --force: overwrites if exists
    const command = `naps2.console -o "${outputPath}" --force --noprofile`;

    console.log(`Starting scan: ${scanId}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Scan Error: ${stderr}`);
            return res.status(500).json({ error: "Scanner communication failed", details: stderr });
        }

        // Rule 7: Stream file back to browser
        res.download(outputPath, `scan_${scanId}.pdf`, (err) => {
            if (err) {
                 console.error("Transmission error");
            }
            // Rule 4.1.6: Clean up temp file immediately after sending
            fs.unlink(outputPath, () => console.log(`Cleaned up ${scanId}`));
        });
    });
});

// Rule 8: OCR Endpoint (Optional - using Tesseract.js wrapper)
// Implementation would receive the file from /scan or a separate upload
// and run local tesseract.

// Export app for testing
export { app };

if (require.main === module) {
    app.listen(PORT, '127.0.0.1', () => {
        console.log(`SudanScan Bridge running at http://127.0.0.1:${PORT}`);
    });
}