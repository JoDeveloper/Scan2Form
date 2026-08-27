import { Scan2Form } from '../dist/esm/scanner-client.js';

const root = document.documentElement;
const elements = {
    connectionBadge: document.getElementById('connection-badge'),
    themeToggle: document.getElementById('theme-toggle'),
    setupTitle: document.getElementById('setup-title'),
    refreshDevices: document.getElementById('refresh-devices'),
    scanForm: document.getElementById('scan-form'),
    deviceSelect: document.getElementById('device-select'),
    deviceHelp: document.getElementById('device-help'),
    bridgeToken: document.getElementById('bridge-token'),
    dpiSelect: document.getElementById('dpi-select'),
    modeSelect: document.getElementById('mode-select'),
    mockCheck: document.getElementById('mock-check'),
    fileInput: document.getElementById('document-upload'),
    scanButton: document.getElementById('scan-btn'),
    scanButtonLabel: document.getElementById('scan-btn-label'),
    cancelScan: document.getElementById('cancel-scan'),
    scanStatus: document.getElementById('scan-status'),
    scanProgress: document.getElementById('scan-progress'),
    formSubmit: document.getElementById('form-submit'),
    resultTitle: document.getElementById('result-title'),
    clearResult: document.getElementById('clear-result'),
    emptyResult: document.getElementById('empty-result'),
    loadingResult: document.getElementById('loading-result'),
    previewContainer: document.getElementById('preview-container'),
    previewImage: document.getElementById('preview-image'),
    previewPdf: document.getElementById('preview-pdf'),
    fileMeta: document.getElementById('file-meta'),
    filename: document.getElementById('filename'),
    filesize: document.getElementById('filesize'),
    downloadLink: document.getElementById('download-link'),
    bridgeTitle: document.getElementById('bridge-title'),
    engineBadge: document.getElementById('engine-badge'),
};

let bridgeOnline = false;
let bridgeBusy = false;
let serverBusy = false;
let activeAbortController = null;
let cancelRequested = false;
let latestFile = null;
let previewUrl = null;
let scanner = createScanner();

function createScanner() {
    const token = elements.bridgeToken.value.trim();
    return new Scan2Form({ requestTimeoutMs: 120000, token: token || undefined });
}

function setStatus(kind, message) {
    elements.scanStatus.className = 'scan-status';
    if (kind) elements.scanStatus.classList.add(`scan-status-${kind}`);
    elements.scanStatus.textContent = message;
}

function setConnection(kind, message) {
    elements.connectionBadge.className = `status-chip status-chip-${kind}`;
    elements.connectionBadge.textContent = message;
}

function selectedFormat() {
    return document.querySelector('input[name="format"]:checked')?.value || 'pdf';
}

function updateFileAccept() {
    elements.fileInput.accept = selectedFormat() === 'pdf' ? 'application/pdf' : 'image/jpeg';
}

function setBusy(isBusy) {
    bridgeBusy = isBusy || serverBusy;
    elements.scanButton.disabled = bridgeBusy;
    elements.refreshDevices.disabled = isBusy;
    elements.deviceSelect.disabled = bridgeBusy || !bridgeOnline;
    updateAdvancedAvailability();
    elements.mockCheck.disabled = bridgeBusy;
    elements.bridgeToken.disabled = bridgeBusy;
    elements.cancelScan.hidden = !isBusy;
    elements.scanProgress.hidden = !isBusy;
    elements.scanProgress.classList.toggle('is-active', isBusy);
    elements.scanProgress.setAttribute('aria-valuetext', isBusy ? 'Scanning' : 'Ready');
    elements.scanButtonLabel.textContent = isBusy ? 'Scanning...' : 'Start scan';
    elements.formSubmit.disabled = bridgeBusy || !latestFile;
}

function updateAdvancedAvailability() {
    const hasSelectedDevice = Boolean(elements.deviceSelect.value);
    const disabled = bridgeBusy || !bridgeOnline || !hasSelectedDevice || elements.mockCheck.checked;
    elements.dpiSelect.disabled = disabled;
    elements.modeSelect.disabled = disabled;
}

function fillDevices(devices) {
    const previous = elements.deviceSelect.value;
    elements.deviceSelect.replaceChildren();

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default scanner profile';
    elements.deviceSelect.appendChild(defaultOption);

    for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.id || device.name;
        option.textContent = device.name;
        elements.deviceSelect.appendChild(option);
    }

    if ([...elements.deviceSelect.options].some(option => option.value === previous)) {
        elements.deviceSelect.value = previous;
    }
    elements.deviceSelect.disabled = !bridgeOnline || bridgeBusy;
    updateAdvancedAvailability();
    elements.deviceHelp.textContent = devices.length
        ? 'Choose a device or keep the default profile.'
        : 'No scanner was listed. The default profile will be used.';
}

async function refreshBridge() {
    scanner = createScanner();
    elements.refreshDevices.disabled = true;
    setConnection('pending', 'Checking bridge');

    const health = await scanner.getHealth();
    bridgeOnline = health.success;
    serverBusy = Boolean(health.health?.busy);
    bridgeBusy = serverBusy;

    if (!health.success) {
        elements.bridgeTitle.textContent = 'Bridge offline';
        elements.engineBadge.textContent = 'Not available';
        elements.deviceSelect.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Start the bridge to list scanners';
        elements.deviceSelect.appendChild(option);
        elements.deviceSelect.disabled = true;
        setConnection('error', 'Bridge offline');
        setStatus('error', health.error || 'Start the local bridge, then refresh this page.');
        elements.refreshDevices.disabled = false;
        setBusy(false);
        return;
    }

    elements.bridgeTitle.textContent = health.health?.busy ? 'Scan in progress' : 'Bridge connected';
    elements.engineBadge.textContent = health.health?.engine || 'Ready';
    setConnection(serverBusy ? 'busy' : 'success', serverBusy ? 'Bridge busy' : 'Bridge connected');

    const devices = await scanner.listDevices({ refresh: true });
    if (devices.error) {
        fillDevices([]);
        elements.deviceHelp.textContent = devices.error;
    } else {
        fillDevices(devices.devices);
    }
    setStatus(serverBusy ? 'error' : '', serverBusy ? 'A scan is already running.' : 'Ready when you are.');
    elements.refreshDevices.disabled = false;
    setBusy(false);
}

function attachFile(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    elements.fileInput.files = dataTransfer.files;
    elements.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
}

function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve();
        }, milliseconds);
        const cancel = () => {
            clearTimeout(timer);
            reject(new Error('Request cancelled'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

async function createMockFile(format, signal) {
    await wait(500, signal);
    if (format === 'pdf') {
        const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
        return new File([pdf], 'mock_scan.pdf', { type: 'application/pdf' });
    }

    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 680;
    const context = canvas.getContext('2d');
    if (context) {
        context.fillStyle = getComputedStyle(root).getPropertyValue('--surface-soft');
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = getComputedStyle(root).getPropertyValue('--accent');
        context.fillRect(72, 76, 220, 18);
        context.fillStyle = getComputedStyle(root).getPropertyValue('--ink');
        context.font = '700 42px system-ui';
        context.fillText('Scan2Form sample', 72, 178);
        context.font = '400 24px system-ui';
        context.fillText('This is a local test file.', 72, 230);
    }

    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, 0.9));
    return new File([blob || 'Scan2Form sample'], `mock_scan.${format === 'png' ? 'png' : 'jpg'}`, { type: mimeType });
}

function renderResult(file) {
    latestFile = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);

    elements.resultTitle.textContent = 'Scan attached';
    elements.emptyResult.hidden = true;
    elements.loadingResult.hidden = true;
    elements.previewContainer.hidden = false;
    elements.fileMeta.hidden = false;
    elements.clearResult.hidden = false;
    elements.filename.textContent = file.name;
    elements.filesize.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB`;
    elements.downloadLink.href = previewUrl;
    elements.downloadLink.download = file.name;

    const isPdf = file.type === 'application/pdf';
    elements.previewImage.hidden = isPdf;
    elements.previewPdf.hidden = !isPdf;
    if (isPdf) {
        elements.previewPdf.src = previewUrl;
    } else {
        elements.previewImage.src = previewUrl;
    }
    elements.formSubmit.disabled = false;
}

function clearResult() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    latestFile = null;
    elements.fileInput.value = '';
    elements.previewImage.removeAttribute('src');
    elements.previewPdf.removeAttribute('src');
    elements.resultTitle.textContent = 'No scan yet';
    elements.emptyResult.hidden = false;
    elements.loadingResult.hidden = true;
    elements.previewContainer.hidden = true;
    elements.fileMeta.hidden = true;
    elements.clearResult.hidden = true;
    elements.formSubmit.disabled = true;
    setStatus('', 'Ready when you are.');
}

function scanOptions(signal) {
    const options = { format: selectedFormat(), signal };
    const selectedDevice = elements.deviceSelect.value;
    const dpiValue = elements.dpiSelect.value;
    const mode = elements.modeSelect.value;
    if (selectedDevice) options.deviceId = selectedDevice;
    if (dpiValue) options.dpi = Number(dpiValue);
    if (mode) options.mode = mode;
    return options;
}

async function handleScan() {
    if (bridgeBusy) return;
    const useMock = elements.mockCheck.checked;
    if (!useMock && !bridgeOnline) {
        setStatus('error', 'Connect the bridge before starting a real scan.');
        return;
    }

    cancelRequested = false;
    activeAbortController = new AbortController();
    scanner = createScanner();
    clearResult();
    setBusy(true);
    elements.emptyResult.hidden = true;
    elements.loadingResult.hidden = false;
    elements.previewContainer.hidden = true;
    elements.fileMeta.hidden = true;
    setStatus('', useMock ? 'Creating a sample file...' : 'Scanning from the selected device...');

    let result;
    try {
        if (useMock) {
            const file = await createMockFile(selectedFormat(), activeAbortController.signal);
            attachFile(file);
            result = { success: true, file };
        } else {
            result = await scanner.scanToInput('document-upload', scanOptions(activeAbortController.signal));
        }

        if (result.success && result.file) {
            renderResult(result.file);
            setStatus('success', useMock ? 'Sample file attached.' : 'Scan complete and attached to the form.');
        } else if (cancelRequested || result.error === 'Request cancelled') {
            elements.emptyResult.hidden = false;
            setStatus('', 'Scan cancelled.');
        } else {
            elements.emptyResult.hidden = false;
            setStatus('error', result.error || 'The scan could not be completed.');
        }
    } catch (error) {
        elements.emptyResult.hidden = false;
        setStatus(cancelRequested ? '' : 'error', cancelRequested ? 'Scan cancelled.' : error.message || 'The scan could not be completed.');
    } finally {
        activeAbortController = null;
        setBusy(false);
        elements.loadingResult.hidden = true;
    }
}

function applyTheme(theme) {
    root.dataset.theme = theme;
    elements.themeToggle.textContent = `Theme: ${theme}`;
    elements.themeToggle.setAttribute('aria-label', `Change theme, currently ${theme}`);
    try {
        localStorage.setItem('scan2form-theme', theme);
    } catch {
        // Private browsing can disable localStorage.
    }
}

function nextTheme() {
    const themes = ['system', 'light', 'dark'];
    const current = root.dataset.theme || 'system';
    applyTheme(themes[(themes.indexOf(current) + 1) % themes.length]);
}

for (const input of document.querySelectorAll('input[name="format"]')) {
    input.addEventListener('change', updateFileAccept);
}

elements.scanForm.addEventListener('submit', event => {
    event.preventDefault();
    void handleScan();
});
elements.cancelScan.addEventListener('click', () => {
    cancelRequested = true;
    elements.cancelScan.hidden = true;
    setStatus('', 'Cancelling scan...');
    activeAbortController?.abort();
});
elements.refreshDevices.addEventListener('click', () => void refreshBridge());
elements.deviceSelect.addEventListener('change', updateAdvancedAvailability);
elements.clearResult.addEventListener('click', clearResult);
elements.formSubmit.addEventListener('click', () => {
    if (latestFile) setStatus('success', 'The file input is ready for your form submission.');
});
elements.mockCheck.addEventListener('change', () => {
    updateAdvancedAvailability();
    setStatus('', elements.mockCheck.checked ? 'Test mode is on. No scanner is needed.' : 'Ready when you are.');
});
elements.themeToggle.addEventListener('click', nextTheme);

try {
    const savedTheme = localStorage.getItem('scan2form-theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') applyTheme(savedTheme);
    else applyTheme('system');
} catch {
    applyTheme('system');
}

updateFileAccept();
setBusy(false);
void refreshBridge();

window.addEventListener('beforeunload', () => {
    activeAbortController?.abort();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
});
