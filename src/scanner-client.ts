import io from 'socket.io-client';
import { ScanFormat } from './types';

// Backward compatibility types
type ScanResult = { success: boolean, file?: File, error?: any };

export class Scan2Form {
    private bridgeUrl: string;
    private socket: any | null = null;
    private listeners: Record<string, ((data: any) => void)[]> = {};

    constructor(bridgeUrl: string = 'http://127.0.0.1:3000') {
        this.bridgeUrl = bridgeUrl;
    }

    /**
     * Connect to the bridge server via WebSocket.
     */
    async connect(): Promise<void> {
        if (this.socket && this.socket.connected) return;

        return new Promise((resolve, reject) => {
            this.socket = io(this.bridgeUrl);

            this.socket.on('connect', () => {
                resolve();
            });

            this.socket.on('connect_error', (err: Error) => {
                reject(err);
            });

            // Global event router
            this.socket.onAny((event: string, ...args: any[]) => {
                if (this.listeners[event]) {
                    this.listeners[event].forEach(cb => cb(args[0]));
                }
            });
        });
    }

    /**
     * Check if bridge is available (HTTP check + simple WS check)
     */
    async isAvailable(): Promise<{ success: boolean; error?: string }> {
        try {
            const res = await fetch(`${this.bridgeUrl}/health`);
            if (res.ok) return { success: true };
            return { success: false, error: res.statusText };
        } catch (e: any) {
            return { success: false, error: e.message || "Network Error" };
        }
    }

    async getDevices(): Promise<{ devices: string[], error?: string }> {
        try {
            const res = await fetch(`${this.bridgeUrl}/devices`);
            const data = await res.json();
            
            if(!res.ok) {
                return { devices: [], error: data.error || data.message || res.statusText };
            }
            
            return { 
                devices: Array.isArray(data.devices) 
                    ? data.devices.map((d: any) => typeof d === 'string' ? d : d.name) 
                    : [], 
                error: data.error 
            };

        } catch (e: any) {
            return { devices: [], error: "Bridge unreachable" };
        }
    }

    /**
     * Listen for scan events.
     */
    on(event: 'scan:start' | 'scan:progress' | 'scan:page' | 'scan:complete' | 'scan:error', callback: (data: any) => void) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    /**
     * Remove event listener.
     */
    off(event: string, callback?: (data: any) => void) {
        if (!this.listeners[event]) return;
        if (!callback) {
            delete this.listeners[event];
        } else {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    /**
     * Start a scan via WebSocket. 
     * Recommended: use .on() listeners to handle the result.
     */
    async startScan(options?: { format?: ScanFormat, deviceId?: string }): Promise<void> {
        if (!this.socket || !this.socket.connected) await this.connect();
        this.socket?.emit('scan:start', options || {});
    }

    /**
     * Legacy Wrapper: Performs a scan and resolves with the final file.
     * Uses the new WebSocket architecture under the hood.
     */
    async scanToInput(inputId: string, options?: { format?: ScanFormat, deviceId?: string }): Promise<ScanResult> {
        const inputElement = document.getElementById(inputId) as HTMLInputElement;
        if (!inputElement) throw new Error("Input element not found");

        if (!this.socket || !this.socket.connected) {
            try {
                await this.connect();
            } catch (e: any) {
               return { success: false, error: "Failed to connect to scanner bridge." };
            }
        }

        return new Promise<ScanResult>((resolve) => {
            let scanId: string;

            const cleanup = () => {
                this.off('scan:complete', onComplete);
                this.off('scan:error', onError);
            };

            const onComplete = (data: { scanId: string, file: ArrayBuffer }) => {
                if (data.scanId !== scanId) return;
                
                try {
                     const blob = new Blob([data.file], { type: 'application/pdf' }); // Mime typing needs smarts, default to PDF/generic for now or inspect bytes
                     // We need to infer type from format option or bytes.
                     // Simplified for legacy wrapper:
                     const mimeType = options?.format === 'jpeg' ? 'image/jpeg' : 'application/pdf';
                     const ext = mimeType === 'image/jpeg' ? 'jpg' : 'pdf';
                     
                     const file = new File([blob], `scanned_doc_${Date.now()}.${ext}`, { type: mimeType });
                     
                     const dataTransfer = new DataTransfer();
                     dataTransfer.items.add(file);
                     inputElement.files = dataTransfer.files;
                     inputElement.dispatchEvent(new Event('change', { bubbles: true }));

                     cleanup();
                     resolve({ success: true, file });
                } catch (e: any) {
                    cleanup();
                    resolve({ success: false, error: e.message });
                }
            };

            const onError = (data: { scanId: string, message: string }) => {
                if (data.scanId !== scanId) return;
                cleanup();
                resolve({ success: false, error: data.message });
            };

            this.on('scan:complete', onComplete);
            this.on('scan:error', onError);

            // Hook into 'started' to match ID? Or just grab first one.
            // For simplicity, we assume one scan at a time per client connection in this wrapper.
            this.socket?.once('scan:started', (data: { scanId: string }) => {
                scanId = data.scanId;
            });

            this.socket?.emit('scan:start', options || {});
        });
    }
}