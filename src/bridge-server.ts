#!/usr/bin/env node
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from './config';
import { ScannerEngine, ScanEvent } from './engines/scanner-engine';
import { Naps2Engine } from './engines/naps2-engine';
import { SaneEngine } from './engines/sane-engine';
import { ScanError } from './errors';
import { ScanFormat } from './types';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow all origins for local bridge
        methods: ["GET", "POST"]
    }
});

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

// --- Socket.io Logic ---

io.on('connection', (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('scan:start', async (data: { deviceId?: string, format?: string }) => {
        const scanId = uuidv4();
        const format = (data.format || 'pdf').toLowerCase() as ScanFormat;
        const deviceId = data.deviceId;

        console.log(`[${scanId}] Scan requested via Socket. Format: ${format}`);
        socket.emit('scan:started', { scanId });

        if (!CONFIG.ALLOWED_FORMATS.includes(format)) {
            socket.emit('scan:error', { scanId, code: 'INVALID_FORMAT', message: `Invalid format. Supported: ${CONFIG.ALLOWED_FORMATS.join(', ')}` });
            return;
        }

        const ext = format === 'jpeg' ? 'jpg' : format;
        const finalFilePath = path.join(CONFIG.TEMP_DIR, `scan_${scanId}.${ext}`);

        try {
            const engine = await getEngine();
            
            // Event Handler for Engine
            const onEvent = (event: ScanEvent) => {
                // Relay internal engine events to socket client
                // We prefix with 'scan:' to match our protocol
                if (event.type === 'progress') socket.emit('scan:progress', { scanId, ...event.payload });
                if (event.type === 'page') socket.emit('scan:page', { scanId, ...event.payload });
                if (event.type === 'complete') {
                     // Read file and send it? Or just send path/URL? 
                     // For 'complete', we originally agreed to send the file.
                     // But for large files, reading into buffer might be heavy. 
                     // Let's send a URL that can be fetched via the static middleware, OR the simple path if local.
                     // To follow the plan "scan:complete: { scanId, file: Buffer }", let's try reading it.
                     try {
                         const fileBuffer = fs.readFileSync(event.payload.path);
                         socket.emit('scan:complete', { scanId, file: fileBuffer });
                         
                         // Cleanup
                         fs.unlink(event.payload.path, (err) => { if (err) console.error("Cleanup error:", err); });

                     } catch (readErr: any) {
                         socket.emit('scan:error', { scanId, code: 'READ_FAILED', message: 'Failed to read output file.' });
                     }
                }
                if (event.type === 'error') socket.emit('scan:error', { scanId, code: 'SCAN_FAILED', message: event.payload.error });
            };

            console.log(`Starting scan with ${engine.name}...`);
            await engine.scan(scanId, { format, deviceId }, finalFilePath, onEvent);

        } catch (error: any) {
            console.error("Scan Error:", error);
            socket.emit('scan:error', { scanId, code: 'UNKNOWN_ERROR', message: error.message });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});


// --- HTTP Endpoints ---

app.get('/health', async (req, res) => {
    try {
        const engine = await getEngine();
        res.json({ status: "ok", engine: engine.name, version: "2.0.0", mode: "socket-enabled" });
    } catch (e) {
         res.status(503).json({ status: "error", error: "No Engine Available" });
    }
});

app.use('/example', express.static(path.join(__dirname, '../example')));
app.use('/dist', express.static(path.join(__dirname, '../dist')));
app.use('/lib/socket.io-client', express.static(path.join(__dirname, '../node_modules/socket.io-client/dist')));

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

// Deprecated: Legacy POST point
app.post('/scan', async (req, res) => {
    res.status(410).json({ error: "Deprecated. Use WebSocket connection." });
});

export { app, httpServer };

if (require.main === module) {
    httpServer.listen(CONFIG.PORT, () => { // Listen on httpServer, not app
        console.log(`Scan2Form Bridge (WebSocket) running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
        console.log(`Open Example: http://${CONFIG.HOST}:${CONFIG.PORT}/example/index.html`);
    });
}