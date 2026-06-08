#!/usr/bin/env node
/**
 * Ad-hoc profiling script for getSessionMessages internals
 */
import { performance } from 'perf_hooks';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const SESSION_ID = '9e01a0ef-9ac9-43ea-8d22-da84b741aac4';
const PROJECT_NAME = '-Users-edward-MyFolder-claudecodeui';
const projectDir = path.join(os.homedir(), '.claude/projects', PROJECT_NAME);

function mark(label) { return { label, t: performance.now() }; }

// ─── Current approach: scan ALL dirs ──────────────────────────────────────────
console.log('=== CURRENT: scan all session dirs ===');
let t = mark('start');

const entries = await fs.readdir(projectDir, { withFileTypes: true });
const allDirs = entries.filter(e => e.isDirectory());
const t1 = mark(`readdir (${entries.length} entries, ${allDirs.length} dirs)`);

const agentFilesMap = new Map();
let checkedDirs = 0, foundDirs = 0, enoentCount = 0;
for (const sessionDir of allDirs) {
  const subagentsDir = path.join(projectDir, sessionDir.name, 'subagents');
  checkedDirs++;
  try {
    const subagentFiles = await fs.readdir(subagentsDir);
    foundDirs++;
    for (const file of subagentFiles) {
      if (file.endsWith('.jsonl') && file.startsWith('agent-')) {
        agentFilesMap.set(file, path.join(subagentsDir, file));
      }
    }
  } catch {
    enoentCount++;
  }
}
const t2 = mark(`subagent scan (${checkedDirs} dirs, ${foundDirs} had subagents, ${enoentCount} ENOENT)`);

console.log(`  readdir:       ${(t1.t - t.t).toFixed(1)}ms`);
console.log(`  subagent scan: ${(t2.t - t1.t).toFixed(1)}ms`);
console.log(`  TOTAL:         ${(t2.t - t.t).toFixed(1)}ms`);
console.log(`  agentFiles:    ${agentFilesMap.size}`);

// ─── Optimized approach: only scan current session's dir ──────────────────────
console.log('\n=== OPTIMIZED: scan only current session dir ===');
const t3 = mark('start');

const agentFilesMapOpt = new Map();
const subagentsDirOpt = path.join(projectDir, SESSION_ID, 'subagents');
try {
  const files = await fs.readdir(subagentsDirOpt);
  for (const file of files) {
    if (file.endsWith('.jsonl') && file.startsWith('agent-')) {
      agentFilesMapOpt.set(file, path.join(subagentsDirOpt, file));
    }
  }
} catch { /* no subagents dir */ }
const t4 = mark('done');

console.log(`  subagent scan: ${(t4.t - t3.t).toFixed(1)}ms`);
console.log(`  agentFiles:    ${agentFilesMapOpt.size}`);

// ─── JSONL read + parse ────────────────────────────────────────────────────────
console.log('\n=== JSONL read + normalize ===');
const jsonlPath = path.join(projectDir, SESSION_ID + '.jsonl');
const t5 = mark('start');
const raw = await fs.readFile(jsonlPath, 'utf8');
const t6 = mark('readFile');
const lines = raw.split('\n').filter(Boolean);
const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const t7 = mark('parse');

console.log(`  readFile:  ${(t6.t - t5.t).toFixed(1)}ms  (${(raw.length/1024).toFixed(1)} KB)`);
console.log(`  JSON parse: ${(t7.t - t6.t).toFixed(1)}ms  (${parsed.length} entries)`);
console.log(`  subtotal:  ${(t7.t - t5.t).toFixed(1)}ms`);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log(`  Current approach:   ${(t2.t - t.t).toFixed(1)}ms`);
console.log(`  Optimized approach: ${(t4.t - t3.t).toFixed(1)}ms`);
console.log(`  JSONL read+parse:   ${(t7.t - t5.t).toFixed(1)}ms`);
console.log(`  Speedup on scan:    ${((t2.t - t1.t) / (t4.t - t3.t)).toFixed(0)}x`);
