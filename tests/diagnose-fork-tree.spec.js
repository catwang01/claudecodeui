/**
 * Diagnose why the user reports "no fork tree visible".
 *
 * Opens the app, seeds JWT auth, switches to the Recents tab, filters by
 * the claudecodeui project (which is where the recent forks live), and snaps
 * a screenshot + DOM dump.
 */
import { test } from '@playwright/test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import path from 'path';
import os from 'os';

const APP_URL = process.env.APP_URL || 'http://localhost:5201';
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli2', 'auth.db');

function issueToken() {
  const db = new Database(DB_PATH);
  const secret = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
  const user = db.prepare('SELECT id, username FROM users LIMIT 1').get();
  db.close();
  return jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '30m' });
}

test.setTimeout(120_000);

test('diagnose fork tree visibility', async ({ page, context }) => {
  const token = issueToken();
  await context.addInitScript((t) => { window.localStorage.setItem('auth-token', t); }, token);

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Click "Recent" tab
  const recentTab = page.getByRole('button', { name: /^Recent$/i }).first();
  await recentTab.click();
  await page.waitForTimeout(1500);

  // Click the "claudecodeui" project badge if present
  try {
    const badge = page.getByRole('button', { name: /claudecodeui/i }).first();
    if (await badge.isVisible({ timeout: 2000 })) await badge.click();
    await page.waitForTimeout(700);
  } catch {}

  await page.screenshot({ path: 'diag-forktree-01.png', fullPage: true });

  // Dump fork tree state
  const dump = await page.evaluate(() => {
    const forkTreeMode = localStorage.getItem('recents-fork-tree-mode');
    const collapsed = localStorage.getItem('recents-fork-collapsed');
    const rows = [];
    document.querySelectorAll('button[role="button"], [class*="SessionItem"], .group').forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 4 || text.length > 200) return;
      // Look for anything that looks like a session row: has short text, no button-y siblings
      if (/^\s*(Fork tree|Show more|Report|Settings)/i.test(text)) return;
      const style = el.getAttribute('style') || '';
      const ml = /margin-left:\s*(\d+)px/.exec(style)?.[1] || '0';
      if (parseInt(ml) > 0 || text.length < 80) {
        rows.push({ ml, cls: el.className.slice(0, 60), text: text.slice(0, 120) });
      }
    });
    return { forkTreeMode, collapsed, rowCount: rows.length, rows: rows.slice(0, 40) };
  });

  console.log('\n──── FORK TREE DIAG ────');
  console.log('localStorage fork-tree-mode =', dump.forkTreeMode);
  console.log('localStorage fork-collapsed =', dump.collapsed);
  console.log('row count:', dump.rowCount);
  for (const r of dump.rows) console.log(`  ml=${r.ml}  ${r.text}`);

  // Try to fetch what /api/projects returns for recents (to see forkParentId presence)
  const projJson = await page.evaluate(async (t) => {
    const r = await fetch('/api/projects', { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    // Locate claudecodeui project sessions
    const proj = (Array.isArray(j) ? j : j.projects || []).find((p) =>
      p.name === 'C--Users-zhenwang-source-Repos-claudecodeui2-claudecodeui'
    );
    if (!proj) return { error: 'project not found', names: (Array.isArray(j)?j:j.projects||[]).slice(0, 10).map((p) => p.name) };
    const collect = (arr, label) => (arr || []).map((s) => ({
      id: s.id?.slice(0, 8),
      label,
      forkParentId: s.forkParentId ? s.forkParentId.slice(0, 8) : null,
      lastActivity: s.lastActivity,
    }));
    return {
      sessions: collect(proj.sessions, 'claude'),
      copilotSessions: collect(proj.copilotSessions, 'copilot'),
    };
  }, token);

  console.log('\n──── /api/projects sessions for claudecodeui ────');
  console.log(JSON.stringify(projJson, null, 2));
});
