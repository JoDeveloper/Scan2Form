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

// Triggers the scan and puts the file into <input type="file" id="my-input" />
await scanner.scanToInput('my-input');
```

That's it! The file input is now populated with a PDF, just as if the user uploaded it manually.

---

## 🖥️ Setup for End-Users

To make scanning work, the user needs two things installed on their computer:

### 1. The Scanner Engine (NAPS2)
We use the popular open-source NAPS2 engine to talk to drivers (TWAIN/WIA/SANE).
*   **[Download NAPS2](https://www.naps2.com/)** and install it.
*   **Important:** Ensure `naps2.console` is available in your system PATH (Standard installation usually handles this).

### 2. The Bridge Server
This tiny server listens for commands from your website.
```bash
# Run this command in your terminal
npx scan2form-server
```
*   Keep this running while scanning.
*   It runs locally at `http://127.0.0.1:3000`.

---

## 🛠️ System Requirements
*   **Node.js**: v16+
*   **OS**: Windows, Mac, or Linux
*   **Scanner**: Any scanner supported by your OS drivers.