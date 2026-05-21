#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "[pii-proxy] Setting up Python environment..."

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 not found. Please install Python 3.8+"
    exit 1
fi

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "[pii-proxy] Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment and install dependencies
echo "[pii-proxy] Installing dependencies..."
source venv/bin/activate
python3 -m pip install --upgrade pip

# Use prefer-binary on Linux/macOS (compilation usually works there)
pip3 install --prefer-binary -r requirements.txt

# Download spaCy model
echo "[pii-proxy] Downloading spaCy model..."
python3 -m spacy download en_core_web_sm

echo "[pii-proxy] Setup complete."
echo "[pii-proxy] Virtual environment created at: $(pwd)/venv"
