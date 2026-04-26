#!/usr/bin/env node
/**
 * Benchmark: per-operation timing for all ops inside getProjects().
 * Usage: node scripts/bench-projects.js
 *
 * Columns:
 *   extract    - readFirstCwdFromJsonl: find project cwd from .jsonl files
 *   sessions   - getSessions(5): parse all .jsonl files, return top 5
 *   cursor     - getCursorSessions: open SQLite for each cursor session
 *   codex      - getCodexSessions: look up project in shared codex index
 *                (first project also shows index build time in brackets)
 *   gemini     - getGeminiCliSessions: scan ~/.gemini/tmp dirs
 *   taskmaster - fs.stat .taskmaster directory
 */

import { promises as fsp } from 'fs';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import crypto from 'crypto';

function fmtMs(start) { return `${(performance.now() - start).toFixed(1)}ms`; }
function cell(s, w) { return String(s).padStart(w); }

const { getProjects, getSessions, getGeminiCliSessions, getCodexSessions } = await import('../server/projects.js');

// ── helpers replicating non-exported ops ─────────────────────────────────────

async function timeExtract(projectName) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const start = performance.now();
  const files = await fsp.readdir(projectDir).catch(() => []);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  const fileStats = await Promise.all(jsonlFiles.map(async f => ({
    file: f, mtime: (await fsp.stat(path.join(projectDir, f))).mtimeMs
  })));
  fileStats.sort((a, b) => b.mtime - a.mtime);
  let cwd = null;
  for (const { file } of fileStats) {
    cwd = await new Promise(resolve => {
      const stream = fsSync.createReadStream(path.join(projectDir, file));
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let done = false;
      rl.on('line', line => {
        if (done || !line.trim()) return;
        try { const e = JSON.parse(line); if (e.cwd) { done = true; rl.close(); stream.destroy(); resolve(e.cwd); } } catch {}
      });
      rl.on('close', () => { if (!done) resolve(null); });
      stream.on('error', () => resolve(null));
    });
    if (cwd) break;
  }
  return { label: fmtMs(start), cwd };
}

async function timeCursor(projectPath) {
  const { default: sqlite3 } = await import('sqlite3');
  const { open } = await import('sqlite');
  const start = performance.now();
  const hash = crypto.createHash('md5').update(projectPath).digest('hex');
  const cursorDir = path.join(os.homedir(), '.cursor', 'chats', hash);
  let sessionCount = 0;
  try {
    const dirs = await fsp.readdir(cursorDir);
    sessionCount = dirs.length;
    for (const d of dirs.slice(0, 5)) {
      const dbPath = path.join(cursorDir, d, 'store.db');
      try {
        const db = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
        await db.all('SELECT key, value FROM meta');
        await db.close();
      } catch {}
    }
  } catch {}
  return { label: `${fmtMs(start)}${sessionCount > 0 ? `(${sessionCount})` : ''}` };
}

async function timeTaskmaster(projectPath) {
  const start = performance.now();
  try { await fsp.stat(path.join(projectPath, '.taskmaster')); } catch {}
  return { label: fmtMs(start) };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  // 1. Full getProjects() wall-clock time
  console.log('=== 1. Full getProjects() ===\n');
  const t0 = performance.now();
  const projects = await getProjects((p) => {
    const sec = ((performance.now() - t0) / 1000).toFixed(2);
    process.stdout.write(`\r[${sec}s] ${p.phase} ${p.current ?? ''}/${p.total ?? ''} ${p.currentProject ?? ''}`.padEnd(110));
  });
  const totalMs = performance.now() - t0;
  console.log(`\n\nTotal: ${(totalMs / 1000).toFixed(3)}s  |  Projects: ${projects.length}\n`);

  // 2. Per-operation breakdown
  console.log('=== 2. Per-operation timing (sequential, isolated per call) ===\n');
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const entries = await fsp.readdir(claudeDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  const COL = [36, 11, 11, 12, 16, 9, 12];
  const HDR = ['Project', 'extract', 'sessions', 'cursor', 'codex', 'gemini', 'taskmaster'];
  console.log(HDR.map((h, i) => cell(h, COL[i])).join(''));
  console.log('-'.repeat(COL.reduce((a, b) => a + b, 0)));

  // codexIndexRef is shared across all projects (same as getProjects does)
  const codexIndexRef = { sessionsByProject: null };
  const rows = [];

  for (const projectName of dirs) {
    const ext = await timeExtract(projectName);

    const sessLabel = await (async () => {
      const s = performance.now();
      await getSessions(projectName, 5, 0).catch(() => {});
      return fmtMs(s);
    })();

    const cursorLabel = ext.cwd ? (await timeCursor(ext.cwd)).label : '-';

    // First project builds the codex index (expensive); subsequent ones are O(1) lookups.
    const codexLabel = ext.cwd ? await (async () => {
      const s = performance.now();
      const firstBuild = !codexIndexRef.sessionsByProject;
      await getCodexSessions(ext.cwd, { limit: 5, indexRef: codexIndexRef }).catch(() => {});
      const label = fmtMs(s);
      return firstBuild ? `${label}[build]` : label;
    })() : '-';

    const geminiLabel = ext.cwd ? await (async () => {
      const s = performance.now();
      await getGeminiCliSessions(ext.cwd).catch(() => {});
      return fmtMs(s);
    })() : '-';

    const tmLabel = ext.cwd ? (await timeTaskmaster(ext.cwd)).label : '-';

    const row = [projectName.slice(-35), ext.label, sessLabel, cursorLabel, codexLabel, geminiLabel, tmLabel];
    rows.push(row);
    console.log(row.map((v, i) => cell(v, COL[i])).join(''));
  }

  // 3. Totals
  const parseMs = s => { const m = String(s).match(/^([\d.]+)ms/); return m ? parseFloat(m[1]) : 0; };
  const totals = HDR.slice(1).map((_, i) => rows.reduce((acc, r) => acc + parseMs(r[i + 1]), 0).toFixed(1) + 'ms');
  console.log('\n=== 3. Column totals (sum across all projects) ===\n');
  HDR.slice(1).forEach((h, i) => console.log(`  ${h.padEnd(12)} ${totals[i]}`));
  console.log(`\n  Note: getProjects() runs cursor/codex/gemini/taskmaster in parallel per project,`);
  console.log(`  so wall-clock time < sum of columns. The sessions column is the usual bottleneck.`);
}

run().catch(e => { console.error(e); process.exit(1); });
