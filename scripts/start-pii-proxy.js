#!/usr/bin/env node

/**
 * Cross-platform PII proxy launcher
 * Uses the Python virtual environment created by setup scripts
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const piiProxyDir = join(__dirname, '..', 'server', 'pii-proxy');

function getPythonExecutable() {
  const platform = process.platform;
  const venvDir = join(piiProxyDir, 'venv');

  // Check if virtual environment exists
  if (!existsSync(venvDir)) {
    console.error('[pii-proxy] Virtual environment not found.');
    console.error('[pii-proxy] Please run: npm install');
    process.exit(1);
  }

  if (platform === 'win32') {
    return join(venvDir, 'Scripts', 'python.exe');
  } else {
    return join(venvDir, 'bin', 'python3');
  }
}

function startPiiProxy() {
  const pythonExe = getPythonExecutable();
  const port = process.env.PII_PROXY_PORT || '18090';

  console.log(`[pii-proxy] Starting PII proxy on port ${port}...`);
  console.log(`[pii-proxy] Using Python: ${pythonExe}`);

  const proc = spawn(
    pythonExe,
    [
      '-m', 'uvicorn',
      'pii_proxy:app',
      '--host', '127.0.0.1',
      '--port', port,
      '--log-level', 'info'
    ],
    {
      cwd: piiProxyDir,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      }
    }
  );

  proc.on('error', (err) => {
    console.error('[pii-proxy] Failed to start:', err.message);
    process.exit(1);
  });

  proc.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[pii-proxy] Stopped by signal: ${signal}`);
    } else if (code !== 0) {
      console.error(`[pii-proxy] Exited with code: ${code}`);
      process.exit(code);
    }
  });

  // Handle termination signals
  process.on('SIGINT', () => {
    console.log('\n[pii-proxy] Shutting down...');
    proc.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    console.log('\n[pii-proxy] Shutting down...');
    proc.kill('SIGTERM');
  });
}

startPiiProxy();
