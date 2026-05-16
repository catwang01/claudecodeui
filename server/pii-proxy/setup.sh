#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
pip3 install -r requirements.txt
python3 -m spacy download en_core_web_lg
echo "[pii-proxy] Setup complete."
