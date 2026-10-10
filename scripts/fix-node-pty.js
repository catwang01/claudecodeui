#!/usr/bin/env node
/**
 * Apply platform-specific node-pty installation fixes.
 *
 * - macOS: makes the spawn-helper binary executable.
 * - Windows: handles a ConPTY cleanup race when the shell exits before node-pty
 *   queries its console process list.
 *
 * @see https://github.com/microsoft/node-pty/issues/850
 * @module scripts/fix-node-pty
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Fixes the spawn-helper binary permissions for node-pty on macOS.
 *
 * The node-pty package ships the spawn-helper binary without execute permissions
 * (644 instead of 755), which causes "posix_spawnp failed" errors when trying
 * to spawn terminal processes.
 *
 * This function:
 * 1. Checks if running on macOS (darwin)
 * 2. Locates spawn-helper binaries for both arm64 and x64 architectures
 * 3. Sets execute permissions (755) on each binary found
 *
 * @async
 * @function fixSpawnHelper
 * @returns {Promise<void>} Resolves when permissions are fixed or skipped
 * @example
 * // Run as postinstall script
 * await fixSpawnHelper();
 */
async function fixSpawnHelper() {
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

  // Only run on macOS
  if (process.platform !== 'darwin') {
    return;
  }

  const darwinDirs = ['darwin-arm64', 'darwin-x64'];

  for (const dir of darwinDirs) {
    const spawnHelperPath = path.join(nodeModulesPath, dir, 'spawn-helper');

    try {
      // Check if file exists
      await fs.access(spawnHelperPath);

      // Make it executable (755)
      await fs.chmod(spawnHelperPath, 0o755);
      console.log(`[postinstall] Fixed permissions for ${spawnHelperPath}`);
    } catch (err) {
      // File doesn't exist or other error - ignore
      if (err.code !== 'ENOENT') {
        console.warn(`[postinstall] Warning: Could not fix ${spawnHelperPath}: ${err.message}`);
      }
    }
  }
}

async function fixWindowsConptyCleanup() {
  if (process.platform !== 'win32') {
    return;
  }

  const agentPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'node-pty',
    'lib',
    'conpty_console_list_agent.js',
  );
  const original = [
    'var consoleProcessList = getConsoleProcessList(shellPid);',
    'process.send({ consoleProcessList: consoleProcessList });',
  ].join('\n');
  const replacement = [
    'var consoleProcessList;',
    'try {',
    '    consoleProcessList = getConsoleProcessList(shellPid);',
    '} catch (_) {',
    '    // The shell may exit before AttachConsole runs during PTY cleanup.',
    '    consoleProcessList = [shellPid];',
    '}',
    'process.send({ consoleProcessList: consoleProcessList });',
  ].join('\n');

  try {
    const content = await fs.readFile(agentPath, 'utf8');
    if (content.includes(replacement)) {
      return;
    }
    if (!content.includes(original)) {
      console.warn(`[postinstall] Warning: Unsupported node-pty ConPTY helper: ${agentPath}`);
      return;
    }
    await fs.writeFile(agentPath, content.replace(original, replacement), 'utf8');
    console.log(`[postinstall] Fixed ConPTY cleanup race in ${agentPath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[postinstall] Warning: Could not patch ${agentPath}: ${err.message}`);
    }
  }
}

Promise.all([fixSpawnHelper(), fixWindowsConptyCleanup()]).catch(console.error);
