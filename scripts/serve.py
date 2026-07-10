#!/usr/bin/env python3
"""Local static file server with COOP/COEP headers.

Serves the current directory (or the directory this script's cwd is run
from) with:
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

These headers make the page "cross-origin isolated", which is required for
onnxruntime-web to use SharedArrayBuffer-backed multithreaded WASM. Without
them, onnxruntime-web silently falls back to a single WASM thread (slower,
but should not by itself cause a crash) -- however some environments have
been observed to hit an Emscripten "Aborted()" trap in
ort-wasm-simd-threaded.jsep.wasm without cross-origin isolation, so enabling
it is the first thing to try when you see that error.

Usage:
    python3 scripts/serve.py [port]   # default port 8000
"""
import http.server
import socketserver
import sys


class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with socketserver.TCPServer(("", port), COOPCOEPHandler) as httpd:
        print(f"Serving with COOP/COEP headers on http://localhost:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
