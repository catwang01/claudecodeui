#!/usr/bin/env node

/**
 * Cross-platform setup script for PII proxy
 * Detects the platform and runs the appropriate setup script
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const piiProxyDir = join(__dirname, '..', 'server', 'pii-proxy');

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function setupPiiProxy() {
  console.log('[setup-pii-proxy] Detecting platform...');

  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: use PowerShell script
      console.log('[setup-pii-proxy] Running Windows setup...');
      await runCommand('powershell', [
        '-ExecutionPolicy', 'Bypass',
        '-File', join(piiProxyDir, 'setup.ps1')
      ], piiProxyDir);
    } else {
      // Linux/macOS: use bash script
      console.log('[setup-pii-proxy] Running Unix setup...');
      await runCommand('bash', [join(piiProxyDir, 'setup.sh')], piiProxyDir);
    }

    console.log('[setup-pii-proxy] All done!');
  } catch (error) {
    console.error('[setup-pii-proxy] Setup failed:', error.message);
    console.error('\nTo set up manually:');
    if (platform === 'win32') {
      console.error('  cd server\\pii-proxy');
      console.error('  powershell -ExecutionPolicy Bypass -File setup.ps1');
    } else {
      console.error('  cd server/pii-proxy');
      console.error('  bash setup.sh');
    }
    // Don't fail npm install if PII proxy setup fails
    process.exit(0);
  }
}

setupPiiProxy();
