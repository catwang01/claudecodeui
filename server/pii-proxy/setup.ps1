# PowerShell setup script for PII proxy on Windows
$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot
try {
    Write-Host "[pii-proxy] Setting up Python environment..."

    # Check if Python is available
    try {
        $pythonVersion = & python --version 2>&1
        Write-Host "Found: $pythonVersion"
    } catch {
        Write-Error "Python not found. Please install Python 3.8+ from https://www.python.org/"
        exit 1
    }

    # Create virtual environment if it doesn't exist
    if (-not (Test-Path "venv")) {
        Write-Host "[pii-proxy] Creating virtual environment..."
        python -m venv venv
    }

    # Activate virtual environment and install dependencies
    Write-Host "[pii-proxy] Installing dependencies..."
    & ".\venv\Scripts\python.exe" -m pip install --upgrade pip

    # Force binary packages only to avoid compilation issues on Windows
    $env:PIP_ONLY_BINARY = ":all:"
    & ".\venv\Scripts\pip.exe" install -r requirements.txt

    # Download spaCy model
    Write-Host "[pii-proxy] Downloading spaCy model..."
    & ".\venv\Scripts\python.exe" -m spacy download en_core_web_sm

    Write-Host "[pii-proxy] Setup complete."
    Write-Host "[pii-proxy] Virtual environment created at: $PSScriptRoot\venv"
} finally {
    Pop-Location
}
