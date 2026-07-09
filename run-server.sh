#!/bin/bash

echo "Starting local server to serve the modified index.html..."
echo "Please open your browser to http://localhost:8000"

# Try to use Python's built-in server
if command -v python3 &> /dev/null; then
    python3 -m http.server 8000
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer 8000
else
    echo "No Python installation found. Please install Python or use another local server."
fi