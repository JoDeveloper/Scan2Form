#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "Starting Scan2Form Server..."
exec node "$script_dir/dist/bridge-server.js"
