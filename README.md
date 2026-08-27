# Scan2Form

Scan documents from a physical scanner directly into a browser form through a small local bridge.

The bridge runs on the user's computer, keeps scan output in a temporary directory, and removes the result after it has been delivered. It supports NAPS2 on Windows, macOS, and Linux, plus SANE on macOS and Linux.

## Quick start

Install the package and start the local bridge:

```bash
npm install scan2form
npx scan2form-server
```

Open the included example at [http://127.0.0.1:3000/example/index.html](http://127.0.0.1:3000/example/index.html).

In a browser application:

```javascript
import { Scan2Form } from 'scan2form';

const scanner = new Scan2Form();
const result = await scanner.scanToInput('document-upload', {
    format: 'pdf',
    dpi: 300,
    mode: 'color',
});

if (!result.success) {
    console.error(result.error);
}
```

The target must be a normal file input:

```html
<input id="document-upload" name="document" type="file">
```

## Client API

`Scan2Form` accepts either the bridge URL string used by older versions or an options object:

```javascript
const scanner = new Scan2Form({
    bridgeUrl: 'http://127.0.0.1:3000',
    requestTimeoutMs: 90000,
    token: 'optional-local-token',
});
```

Available methods:

- `getHealth()` returns bridge status, engine, supported formats, and busy state.
- `isAvailable()` returns the backwards-compatible availability result.
- `listDevices({ refresh: true })` returns device objects with `id`, `name`, and `driver` when available.
- `getDevices()` returns the backwards-compatible array of device names.
- `scan(options)` returns a `File` without touching the DOM.
- `scanToInput(inputId, options)` attaches the returned file and dispatches a bubbling `change` event.

Scan options:

```typescript
type ScanFormat = 'pdf' | 'jpg' | 'jpeg' | 'png';
type ScanMode = 'color' | 'gray' | 'bw';

interface ScanRequestOptions {
    format?: ScanFormat;
    deviceId?: string;
    dpi?: number;       // 75 through 600
    mode?: ScanMode;
    signal?: AbortSignal;
}
```

Cancel a scan with the standard browser API:

```javascript
const controller = new AbortController();
const pendingScan = scanner.scan({ format: 'pdf', signal: controller.signal });
controller.abort();
await pendingScan;
```

## Scanner engines

### NAPS2

NAPS2 is the recommended option on Windows. Install it and make `naps2.console` available on `PATH`. The bridge uses the configured NAPS2 profile when no device or advanced option is selected. When a device or override is selected, it uses NAPS2's command-line device mode.

If your system needs a specific driver, set `NAPS2_DRIVER` to `wia`, `twain`, `sane`, `escl`, or `apple` before starting the bridge. See the [NAPS2 command-line documentation](https://www.naps2.com/doc/command-line) for driver and device details.

### SANE

On macOS or Linux, install SANE and verify that `scanimage --version` works:

```bash
# macOS
brew install sane-backends

# Debian or Ubuntu
sudo apt-get install sane-utils
```

The bridge uses `scanimage` for capture and `sips` for format conversion on the SANE path.

## Security and configuration

The bridge binds to `127.0.0.1` by default. Keep it on loopback unless a controlled network deployment is required. If it must serve another application origin, configure an exact comma-separated origin allowlist:

```bash
SCAN2FORM_ALLOWED_ORIGINS=https://app.example.com,http://localhost:5173 npx scan2form-server
```

For a bridge bound beyond loopback, also set a token and send it from the client:

```bash
SCAN2FORM_API_TOKEN=use-a-long-random-value HOST=192.168.1.20 npx scan2form-server
```

```javascript
const scanner = new Scan2Form({
    bridgeUrl: 'http://192.168.1.20:3000',
    token: 'use-a-long-random-value',
});
```

The server also applies security headers, a small JSON body limit, exact origin checks, timing-safe token comparison, scan request rate limiting, one active scan at a time, bounded command output, abortable child processes, and non-cacheable scan responses. Temporary scan files are created with restrictive permissions and stale files are cleaned when the bridge starts.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local bridge port |
| `HOST` | `127.0.0.1` | Bind address |
| `TEMP_DIR` | `dist/temp_scans` | Temporary scan directory |
| `SCAN_TIMEOUT_MS` | `60000` | Maximum engine command duration |
| `ENGINE_CACHE_TTL_MS` | `30000` | How long a detected scanner engine is reused |
| `DEVICE_CACHE_TTL_MS` | `10000` | How long the device list is reused |
| `TEMP_FILE_MAX_AGE_MS` | `7200000` | Age at which stale scan files are removed at startup |
| `MAX_SCAN_BYTES` | `104857600` | Maximum delivered scan size |
| `MAX_COMMAND_OUTPUT_BYTES` | `1048576` | Maximum scanner command output captured in memory |
| `MAX_SCAN_REQUESTS_PER_WINDOW` | `6` | Scan requests allowed per rate-limit window and client |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Scan rate-limit window |
| `SCAN2FORM_ALLOWED_ORIGINS` | local bridge origins | Exact browser origin allowlist |
| `SCAN2FORM_API_TOKEN` | unset | Optional bearer token |
| `NAPS2_DRIVER` | platform default | NAPS2 driver used for device mode |

## Development

```bash
npm install
npm run build
npm test
```

The package publishes the compiled server, the browser ESM client, and the example UI. The browser bundle is served at `/dist/esm/scanner-client.js`; the server bundle is not exposed as a static web asset.
