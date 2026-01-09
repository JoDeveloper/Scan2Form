// Rule 5.5: Options Interface
export interface ScanOptions {
    /** Target input element ID to populate with the file */
    targetInputId?: string;
    /** Format of the scanned file. Default: 'pdf' */
    format?: 'pdf' | 'jpg' | 'jpeg' | 'png';
    /** ID of an HTML element (img, iframe, object, embed) to preview the scan */
    previewElementId?: string;
}

export class Scan2Form {
    private bridgeUrl: string;

    constructor(bridgeUrl: string = 'http://127.0.0.1:3000') {
        this.bridgeUrl = bridgeUrl;
    }

    // Rule 5.1: Detect Bridge
    async isAvailable(): Promise<{ success: boolean; error?: string }> {
        try {
            const res = await fetch(`${this.bridgeUrl}/health`);
            return { success: res.ok };
        } catch (e: any) {
            return { success: false, error: e.message || "Network Error" };
        }
    }

    // List available scanners
    async getDevices(): Promise<{ devices: string[], error?: string }> {
        try {
            const res = await fetch(`${this.bridgeUrl}/devices`);
            if(!res.ok) return { devices: [], error: res.statusText };
            const data = await res.json();
            return { devices: data.devices || [], error: data.error };
        } catch (e) {
            return { devices: [], error: "Bridge unreachable" };
        }
    }

    // Rule 5.2 & 5.3: Trigger Scan & Receive Blob
    async scan(options: string | ScanOptions): Promise<{ success: boolean; file?: File; error?: any }> {
        // Backward compatibility: if string, treat as inputId
        let config: ScanOptions = {};
        if (typeof options === 'string') {
            config = { targetInputId: options, format: 'pdf' };
        } else {
            config = { format: 'pdf', ...options };
        }

        try {
            const response = await fetch(`${this.bridgeUrl}/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format: config.format })
            });
            
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.details || "Scan failed or cancelled");
            }

            const blob = await response.blob();
            // Determine mime type based on format or blob
            const mimeType = blob.type || (config.format === 'pdf' ? 'application/pdf' : `image/${config.format}`);

            
            // Rule 5.4: Inject into DataTransfer
            const ext = config.format === 'jpeg' ? 'jpg' : config.format;
            const file = new File([blob], `scanned_doc_${Date.now()}.${ext}`, { type: mimeType });
            
            // Handle Input Population
            if (config.targetInputId) {
                const inputElement = document.getElementById(config.targetInputId) as HTMLInputElement;
                if (inputElement) {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);
                    inputElement.files = dataTransfer.files;
                    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            // Handle Preview
            if (config.previewElementId) {
                this.handlePreview(config.previewElementId, file);
            }
            
            return { success: true, file: file };

        } catch (error) {
            console.error("Scan2Form Error:", error);
            return { success: false, error: (error as any).message || "An unknown error occurred during scan." };
        }
    }

    /**
     * Alias for scan() to maintain backward compatibility, but now supports options.
     */
    async scanToInput(inputIdOrOptions: string | ScanOptions): Promise<{ success: boolean; file?: File; error?: any }> {
        return this.scan(inputIdOrOptions);
    }

    private handlePreview(elementId: string, file: File) {
        const el = document.getElementById(elementId);
        if (!el) return;

        const url = URL.createObjectURL(file);
        const tagName = el.tagName.toLowerCase();

        if (tagName === 'img') {
            (el as HTMLImageElement).src = url;
        } else if (tagName === 'iframe') {
             (el as HTMLIFrameElement).src = url;
        } else if (tagName === 'embed') {
             (el as HTMLEmbedElement).src = url;
             (el as HTMLEmbedElement).type = file.type;
        } else if (tagName === 'object') {
             (el as HTMLObjectElement).data = url;
             (el as HTMLObjectElement).type = file.type;
        }
    }
}