# Security Policy

## Trust posture

Scan2Form is a local bridge that lets a browser page use the machine's physical scanner. Everything below is visible, intended behavior — documented here so users and supply-chain scanners can evaluate it accurately.

### Zero runtime dependencies

As of v1.5.0 the package declares **no runtime dependencies**. The bridge server is implemented with Node.js built-ins only (`node:http`, `node:fs`, `node:crypto`, `node:child_process`), so installing `scan2form` downloads no third-party code. Versions 1.3.1 and earlier depended on `express`, `cors`, and `uuid`; that transitive tree carried known CVEs and unmaintained packages and was removed in the v1.5.0 rewrite with all endpoints and safeguards preserved.

### What the process does

- **Binds an HTTP server** on `127.0.0.1:3000` by default (`HOST`/`PORT` to change). Cross-origin browser access requires an exact origin allowlist match; an optional bearer token (`SCAN2FORM_API_TOKEN`) is compared with `crypto.timingSafeEqual`.
- **Spawns local scanner software** (`naps2.console`, `scanimage`, `sips`) with fixed argument vectors — never through a shell. Device names from requests are passed as single arguments after validation (length, character, and format checks), so they cannot be interpreted as command-line options or shell syntax.
- **Reads environment variables** for configuration only (port, host, limits, origins, token, NAPS2 driver). No secrets beyond the optional API token are read, and nothing is sent anywhere: there is no telemetry, update check, or outbound network call.
- **Writes temporary files** (`scan_<uuid>.<ext>`) into a private directory (mode `0700`, files mode `0600`) and deletes them immediately after delivery to the browser. Stale files are removed on startup.

### Request handling safeguards

- Strict JSON request parsing with a 16 KB body limit (`JSON_BODY_LIMIT_BYTES`)
- Per-client scan rate limiting and a single concurrent scan
- Bounded scanner command output and duration; scans are aborted when the client disconnects
- Security headers on every response (`Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`)
- Static serving restricted to the example UI and the browser client bundle, with path-traversal and dotfile protection
- Non-cacheable API and scan responses (`Cache-Control: no-store`)

## Reporting a vulnerability

Report suspected vulnerabilities privately via [GitHub security advisories](https://github.com/JoDeveloper/Scan2Form/security/advisories/new) or by opening an issue marked as a security concern. Please include reproduction steps and affected versions. Reports are acknowledged within a few days.
