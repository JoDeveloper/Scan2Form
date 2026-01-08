export class Scan2Form {
    private bridgeUrl: string;

    constructor(bridgeUrl: string = 'http://127.0.0.1:3000') {
        this.bridgeUrl = bridgeUrl;
    }

    // Rule 5.1: Detect Bridge
    async isAvailable(): Promise<boolean> {
        try {
            const res = await fetch(`${this.bridgeUrl}/health`);
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    // List available scanners
    async getDevices(): Promise<string[]> {
        try {
            const res = await fetch(`${this.bridgeUrl}/devices`);
            if(!res.ok) return [];
            const data = await res.json();
            return data.devices || [];
        } catch (e) {
            return [];
        }
    }

    // Rule 5.2 & 5.3: Trigger Scan & Receive Blob
    async scanToInput(inputId: string): Promise<{ success: boolean; file?: File; error?: any }> {
        const inputElement = document.getElementById(inputId) as HTMLInputElement;
        if (!inputElement) throw new Error("Input element not found");

        try {
            const response = await fetch(`${this.bridgeUrl}/scan`, { method: 'POST' });
            
            if (!response.ok) throw new Error("Scan failed or cancelled at device");

            const blob = await response.blob();
            
            // Rule 5.4: Inject into DataTransfer
            const file = new File([blob], `scanned_doc_${Date.now()}.pdf`, { type: 'application/pdf' });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            
            inputElement.files = dataTransfer.files;
            
            // Trigger change event so frameworks (React/Vue) detect the update
            inputElement.dispatchEvent(new Event('change', { bubbles: true }));
            
            return { success: true, file: file };

        } catch (error) {
            console.error("Scan2Form Error:", error);
            // Alerting might be annoying in a library, maybe optional? Leaving as is for now but usually libraries shouldn't alert.
            // alert("Ensure Scan2Form Bridge is running!"); 
            return { success: false, error: error };
        }
    }
}