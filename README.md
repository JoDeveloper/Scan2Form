# Scan2Form

**Scan2Form** is a lightweight "bridge" that allows your web application to access physical scanners (TWAIN, WIA, SANE) directly from the browser. 

Since browsers cannot directly access hardware, this package provides:
1.  **A Local Bridge Server**: Runs on the user's machine to talk to the scanner via NAPS2.
2.  **A Client Library**: Running in your web app to request scans and inject the result directly into your `<input type="file">`.

## 🛠️ System Requirements (Crucial)

This bridge relies on ** NAPS2 ** to handle the low-level hardware communication. You must install the Console version on the host machine.

### 1. Install Node.js
Ensure you have [Node.js](https://nodejs.org/) (v16 or higher) installed.

### 2. Install Scanner Engine (NAPS2)
The bridge sends commands to `naps2.console`.

- **Windows:**
  1. Download and install [NAPS2](https://www.naps2.com/).
  2. Add the installation folder (e.g., `C:\Program Files\NAPS2`) to your System **PATH** environment variable.
  3. Verify by opening CMD and typing: `naps2.console`

- **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt install naps2
  # Or download the .deb from naps2.com if not in repos
  ```

## Installation

```bash
npm install scan2form
```

## Usage

### 1. Start the Bridge Server (User's Machine)
The user must run the bridge server locally to allow the web app to communicate with the scanner.

```bash
npx scan2form-server
```
*   Runs on `http://127.0.0.1:3000`.
*   Only accessible from `localhost`.

### 2. Integrate into Your Web App (Developer)

Import the library and use it to trigger a scan. The result will be automatically attached to your hidden file input.

#### HTML
```html
<input type="file" id="scanner-input" style="display: none;" />
<button id="scan-btn">Scan Document</button>
```

#### JavaScript / TypeScript
```javascript
import { SudanScan } from 'scan2form';

const scanner = new SudanScan();

document.getElementById('scan-btn').addEventListener('click', async () => {
    // This looks for <input id="scanner-input">
    const result = await scanner.scanToInput('scanner-input');

    if (result.success) {
        console.log("Scan complete!", result.file);
        // The input now has the file, ready for form submission!
    } else {
        alert("Scan failed. Make sure the Bridge Server is running!");
    }
});
```

### Why use this?
*   **Zero Backend Changes**: It acts exactly like a user uploading a file manually.
*   **Secure**: Binds only to localhost. Files are cleaned up immediately after transfer.
*   **Cross-Platform**: Works on Windows, Mac, and Linux (via NAPS2).