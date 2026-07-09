#!/bin/bash
set -e

# Ensure the browser SDK bundle exists (real agent + engine, transformers.js
# left external and loaded from CDN via the import map in index.html).
if [ ! -f "dist-browser/sdk.js" ]; then
    echo "Browser bundle not found — building it now (pnpm build:browser)..."
    if command -v pnpm &> /dev/null; then
        pnpm build:browser
    else
        echo "pnpm not found. Run 'pnpm install && pnpm build:browser' first."
        exit 1
    fi
fi

echo "Starting local server for the real Local LLM Agent demo..."
echo "Open your browser to http://localhost:8000"
echo "(First model load downloads weights from HuggingFace; cached afterwards.)"

# WebGPU + cross-origin isolation notes:
# transformers.js WASM fallback benefits from COOP/COEP headers, but WebGPU
# works without them. Python's simple server is fine for the WebGPU path.
if command -v python3 &> /dev/null; then
    python3 -m http.server 8000
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer 8000
else
    echo "No Python installation found. Please install Python or use another local server."
fi
