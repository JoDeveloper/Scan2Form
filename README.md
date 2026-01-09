# Scan2Form 🖨️ -> 🌐

**Scan documents from a physical scanner directly into your web form.**

Typically, browsers can't access scanners. **Scan2Form** solves this by running a tiny local bridge on your computer.

---

## 🚀 Quick Start for Developers

**1. Install the package**
```bash
npm install scan2form
```

**2. Add to your frontend code**
```javascript
import { Scan2Form } from 'scan2form';

const scanner = new Scan2Form();

// Triggers the scan. 
// If your input has accept="image/*", it scans as JPEG. Default is PDF.
await scanner.scanToInput('my-input');

// OR use advanced options (e.g. for preview)
await scanner.scan({
    targetInputId: 'my-input', 
    previewElementId: 'scan-preview'
});
```

## 🖼️ Supported Formats & Preview
**Scan2Form** now supports multiple formats:
*   **PDF** (Default)
*   **JPEG / JPG**
*   **PNG**

To preview a scan immediately, simply provide the ID of an HTML element in `previewElementId`.
*   For images, use an `<img>` tag.
*   For PDFs, use `<iframe>`, `<embed>`, or `<object>`.

That's it! The file input is now populated with a PDF, just as if the user uploaded it manually.

---

## 🖥️ Setup for End-Users

To make scanning work, the user needs two things installed on their computer:

### 1. The Scanner Engine
We rely on a local scanning engine. You can use either **NAPS2** (Recommended for Windows) or **SANE** (Recommended for macOS/Linux).

**Option A: NAPS2 (Windows)**
*   **[Download NAPS2](https://github.com/cyanfish/naps2/releases#:~:text=naps2%2D8.2.1%2Dwin%2Darm64.exe)** and install it.
*   **Important:** Ensure `naps2.console` is available in your system PATH.
*   [How to configure NAPS2 Command Line](https://www.naps2.com/doc/command-line)

    > **Tip (Windows PowerShell):** You can set up an alias to make it simple:
    > ```powershell
    > function naps2.console { . "C:\Program Files\NAPS2\NAPS2.Console.exe" $args }
    > ```

**Option B: SANE (macOS / Linux)**
*   **macOS:** Install via Homebrew: `brew install sane-backends`
*   **Linux:** Install via apt: `sudo apt-get install sane-utils`
*   Verify installation by running `scanimage --version` in your terminal.

### 2. The Bridge Server
This tiny server listens for commands from your website.
```bash
# Run this command in your terminal
npx scan2form-server
```
*   Keep this running while scanning.
*   It runs locally at `http://127.0.0.1:3000`.

**Alternative:**
We've included shortcut scripts in the package. If you have the files locally:
*   **Windows:** Double-click `start-server.bat`
*   **Mac/Linux:** Run `./start-server.sh`

---

## 🛠️ System Requirements
*   **Node.js**: v16+
*   **OS**: Windows, Mac, or Linux
*   **Scanner**: Any scanner supported by your OS drivers.