#!/usr/bin/env node
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

// Serve example for testing
app.use('/example', express.static(path.join(__dirname, '../example')));
app.use('/dist', express.static(path.join(__dirname, '../dist')));


// --- Scanner Engine Selection ---
// We check for 'naps2.console' first, then 'scanimage' (SANE).

function getScannerEngine(callback: (engine: 'naps2' | 'sane' | null) => void) {
    exec('naps2.console --help', (err) => {
        if (!err) return callback('naps2');
        exec('scanimage --version', (err2) => {
             if (!err2) return callback('sane');
             callback(null);
        });
    });
}

// --- Endpoints ---

app.get('/devices', (req, res) => {
    getScannerEngine((engine) => {
        if (engine === 'naps2') {
             exec('naps2.console --list', (error, stdout, stderr) => {
                 if (error) {
                     console.error("NAPS2 List Error:", stderr);
                     return res.json([]);
                 }
                 const devices = stdout.split('\n').filter(line => line.trim().length > 0);
                 res.json({ devices });
             });
        } else if (engine === 'sane') {
             exec('scanimage -L', (error, stdout, stderr) => {
                 if (error) {
                     console.error("SANE List Error:", stderr);
                     return res.json([]);
                 }
                 // scanimage -L output: "device `epsonds:libusb:002:003' is a Epson DS-530 II"
                 // We want to return a friendly name or the ID.
                 const devices = stdout.split('\n')
                    .filter(line => line.includes('is a'))
                    .map(line => {
                        // Cleanup string
                        return line.replace('device `', '').replace(`'`, ''); 
                    });
                 res.json({ devices });
             });
        } else {
            const msg = "No scanner software found. Please install NAPS2 (Windows) or SANE (Mac/Linux).";
            console.error(msg);
            res.json({ devices: [], error: msg });
        }
    });
});

app.post('/scan', async (req, res) => {
    const scanId = uuidv4();
    // Default to PDF if not specified
    const format = (req.body.format || 'pdf').toLowerCase();
    
    // Usage: format can be 'pdf', 'jpg', 'jpeg', 'png'
    const allowedFormats = ['pdf', 'jpg', 'jpeg', 'png'];
    if (!allowedFormats.includes(format)) {
        return res.status(400).json({ error: "Invalid format. Supported: pdf, jpg, png" });
    }

    // Map format to file extension
    const ext = format === 'jpeg' ? 'jpg' : format;
    const finalFilePath = path.join(TEMP_DIR, `scan_${scanId}.${ext}`);

    getScannerEngine((engine) => {
        if (!engine) {
            return res.status(500).json({ error: "No scanner software installed (NAPS2 or SANE)." });
        }

        if (engine === 'naps2') {
            // NAPS2 detects format by extension
            const cmd = `naps2.console -o "${finalFilePath}" -v`;
            console.log(`Scanning with NAPS2 (${format}): ${cmd}`);
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`NAPS2 Error: ${error.message}`);
                    const errorDetail = stderr || error.message;
                    return res.status(500).json({ error: "Scan failed", details: errorDetail });
                }
                if (fs.existsSync(finalFilePath)) {
                    res.sendFile(finalFilePath, () => {
                        fs.unlink(finalFilePath, (err) => { if(err) console.error("Cleanup error:", err); });
                    });
                } else {
                    res.status(500).json({ error: "Scan completed but file not found.", details: "Output file missing." });
                }
            });
        } else if (engine === 'sane') {
            // SANE flow: scanimage -> tiff -> sips -> target format
            const tempTiffPath = path.join(TEMP_DIR, `scan_${scanId}.tiff`);
            const cmd = `scanimage --format=tiff --mode Color --resolution 300 > "${tempTiffPath}"`; 
            
            console.log(`Scanning with SANE: ${cmd}`);
            exec(cmd, (error, stdout, stderr) => {
                 if (error) {
                     console.error(`SANE Error: ${error.message}`);
                     const errorDetail = stderr || error.message;
                     return res.status(500).json({ error: "Scan failed", details: errorDetail });
                 }

                 // Convert TIFF to Target Format using 'sips'
                 // sips support: pdf, jpeg, png
                 let sipsFormat = format;
                 if (format === 'jpg') sipsFormat = 'jpeg';

                 const convertCmd = `sips -s format ${sipsFormat} "${tempTiffPath}" --out "${finalFilePath}"`;
                 
                 console.log(`Converting: ${convertCmd}`);
                 exec(convertCmd, (cErr, cOut, cStderr) => {
                     // Cleanup TIFF immediately
                     if(fs.existsSync(tempTiffPath)) fs.unlinkSync(tempTiffPath);

                     if (cErr) {
                         console.error(`Conversion Error: ${cStderr}`);
                         return res.status(500).json({ error: "Image conversion failed" });
                     }

                     if (fs.existsSync(finalFilePath)) {
                        res.sendFile(finalFilePath, () => {
                            fs.unlink(finalFilePath, (err) => { if(err) console.error("Cleanup error:", err); });
                        });
                     } else {
                        res.status(500).json({ error: "Conversion completed but file not found." });
                     }
                 });
            });
        }
    });
});

// Rule 8: OCR Endpoint (Optional - using Tesseract.js wrapper)
// Implementation would receive the file from /scan or a separate upload
// and run local tesseract.

// Export app for testing
export { app };

if (require.main === module) {
    app.listen(PORT, '127.0.0.1', () => {
        console.log(`Scan2Form Bridge running at http://127.0.0.1:${PORT}`);
        console.log(`Open Example: http://127.0.0.1:${PORT}/example/index.html`);
    });
}