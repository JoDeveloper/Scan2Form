import { ScanFormat } from './types';

export class Scan2Form {
    private bridgeUrl: string;

    constructor(bridgeUrl: string = 'http://127.0.0.1:3000') {
        this.bridgeUrl = bridgeUrl;
    }

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

    async scanToInput(inputId: string, options?: { format?: ScanFormat, deviceId?: string }): Promise<{ success: boolean; file?: File; error?: any }> {
        const inputElement = document.getElementById(inputId) as HTMLInputElement;
        if (!inputElement) throw new Error("Input element not found");

        try {
            const response = await fetch(`${this.bridgeUrl}/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options || {})
            });
            
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || errData.details || "Scan failed");
            }

            const blob = await response.blob();
            const mimeType = blob.type || 'application/pdf';
            const ext = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'pdf');
            const file = new File([blob], `scanned_doc_${Date.now()}.${ext}`, { type: mimeType });
            
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            inputElement.files = dataTransfer.files;
            inputElement.dispatchEvent(new Event('change', { bubbles: true }));
            
            return { success: true, file: file };

        } catch (error: any) {
            console.error("Scan2Form Error:", error);
            return { success: false, error: error.message || "An unknown error occurred during scan." };
        }
    }
}