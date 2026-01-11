#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from './config';
import { ScannerEngine } from './engines/scanner-engine';
import { Naps2Engine } from './engines/naps2-engine';
import { SaneEngine } from './engines/sane-engine';
import { ScanError } from './errors';
import { ScanFormat } from './types';

const app = express();

// Ensure temp directory exists
if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR);

app.use(cors()); 
app.use(express.json());

// Engine Selection Strategy
const engines: ScannerEngine[] = [new Naps2Engine(), new SaneEngine()];
let cachedEngine: ScannerEngine | null = null;

async function getEngine(): Promise<ScannerEngine> {
    if (cachedEngine) return cachedEngine;
    
    for (const engine of engines) {
        if (await engine.isAvailable()) {
            console.log(`Using Scanner Engine: ${engine.name}`);
            cachedEngine = engine;
            return engine;
        }
    }
    throw new ScanError('NO_ENGINE', 'No supported scanner software found (NAPS2 or SANE).', null, 500);
}

// --- Endpoints ---

app.get('/health', async (req, res) => {
    try {
        const engine = await getEngine();
        res.json({ status: "ok", engine: engine.name, version: "2.0.0" });
    } catch (e) {
         res.status(503).json({ status: "error", error: "No Engine Available" });
    }
});

app.use('/example', express.static(path.join(__dirname, '../example')));
app.use('/dist', express.static(path.join(__dirname, '../dist')));

app.get('/devices', async (req, res) => {
    try {
        const engine = await getEngine();
        const devices = await engine.listDevices();
        res.json({ devices });
    } catch (error: any) {
        console.error("Device List Error:", error);
         const status = error instanceof ScanError ? error.httpStatus : 500;
        res.status(status).json({ devices: [], error: error.message });
    }
});

app.post('/scan', async (req, res) => {
    const scanId = uuidv4();
    const format = (req.body.format || 'pdf').toLowerCase() as ScanFormat;
    const deviceId = req.body.deviceId;
    
    if (!CONFIG.ALLOWED_FORMATS.includes(format)) {
        return res.status(400).json({ error: `Invalid format. Supported: ${CONFIG.ALLOWED_FORMATS.join(', ')}` });
    }

    const ext = format === 'jpeg' ? 'jpg' : format;
    const finalFilePath = path.join(CONFIG.TEMP_DIR, `scan_${scanId}.${ext}`);

    try {
        const engine = await getEngine();
        
        console.log(`Starting scan with ${engine.name}...`);
        await engine.scan({ format, deviceId }, finalFilePath);

        if (fs.existsSync(finalFilePath)) {
            res.sendFile(finalFilePath, () => {
                fs.unlink(finalFilePath, (err) => { if (err) console.error("Cleanup error:", err); });
            });
        } else {
             throw new ScanError('FILE_MISSING', 'Scan finished but output file is missing.', null, 500);
        }

    } catch (error: any) {
        console.error("Scan Error:", error);
        const status = error instanceof ScanError ? error.httpStatus : 500;
        res.status(status).json({ error: "Scan failed", details: error.message });
    }
});

export { app };

if (require.main === module) {
    app.listen(CONFIG.PORT, CONFIG.HOST, () => {
        console.log(`Scan2Form Bridge running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
        console.log(`Open Example: http://${CONFIG.HOST}:${CONFIG.PORT}/example/index.html`);
    });
}