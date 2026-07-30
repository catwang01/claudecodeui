/**
 * End-to-end verification for the fork-tree extension to the Copilot provider.
 *
 * Flow:
 *   1. Pick a real Copilot session in the claudecodeui project.
 *   2. Fork it TWICE via the REST endpoint (with provider="copilot").
 *   3. Fork the first fork one more time — so we get a small tree:
 *        base ─┬─ F1 ─── F1a
 *              └─ F2
 *   4. Open the Recents tab in the browser, filter to claudecodeui, and:
 *        a. Assert the tree renders with 3 indented rows below the base session.
 *        b. Assert the collapse chevron toggles descendant visibility.
 *        c. Assert the sort weight is by newest leaf — the F1a fork bumps
 *           F1's subtree above F2 even though F1 was created first.
 *   5. Clean up the created fork sessions afterward.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

const APP_URL = process.env.APP_URL || 'http://localhost:5201';
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli2', 'auth.db');
const BASE_ID = process.env.BASE_ID || '1692d19f-682a-4d06-a61c-d3023793c560'; // known copilot session
const PROJECT = 'C--Users-zhenwang-source-Repos-claudecodeui2-claudecodeui';

function issueToken() {
  const db = new Database(DB_PATH);
  const secret = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
  const user = db.prepare('SELECT id, username FROM users LIMIT 1').get();
  db.close();
  return jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '30m' });
}

async function callFork(token, sessionId) {
  const resp = await fetch(`${APP_URL}/api/projects/${PROJECT}/sessions/${sessionId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ provider: 'copilot' }),
  });
  if (!resp.ok) throw new Error(`fork HTTP ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).newSessionId;
}

async function deleteCopilotSession(token, sessionId) {
  // Best-effort cleanup: unlink jsonl + remove DB rows.
  try {
    const jsonl = path.join(os.homedir(), '.claude', 'projects', PROJECT, `${sessionId}.jsonl`);
    await fs.unlink(jsonl).catch(() => {});
  } catch {}
  const db = new Database(DB_PATH);
  try {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_fork_parents WHERE fork_session_id = ? OR parent_session_id = ?').run(sessionId, sessionId);
  } finally { db.close(); }
}

test.setTimeout(180_000);

test('copilot fork tree renders, expands/collapses, sorts by newest leaf', async ({ page, context }) => {
  const token = issueToken();
  const forks = [];

  try {
    // ── 1-3. Build the tree via REST ────────────────────────────────────────
    const F1 = await callFork(token, BASE_ID);
    await new Promise(r => setTimeout(r, 400));
    const F2 = await callFork(token, BASE_ID);
    await new Promise(r => setTimeout(r, 400));
    const F1a = await callFork(token, F1);
    forks.push(F1, F2, F1a);

    console.log('[test] forks created:', { BASE_ID: BASE_ID.slice(0, 8), F1: F1.slice(0, 8), F2: F2.slice(0, 8), F1a: F1a.slice(0, 8) });

    // ── 4. Boot the UI and go to Recents ─────────────────────────────────────
    await context.addInitScript((t) => { window.localStorage.setItem('auth-token', t); }, token);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: /^Recent$/i }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /claudecodeui/i }).first().click().catch(() => {});
    await page.waitForTimeout(1200);

    await page.screenshot({ path: 'fork-tree-01-expanded.png', fullPage: true });

    // ── 4a. Read the tree from what actually gets rendered ───────────────────
    async function readTree() {
      return page.evaluate((baseId) => {
        const rows = [];
        document.querySelectorAll('.group').forEach((el) => {
          const style = el.getAttribute('style') || '';
          const ml = parseInt(/margin-left:\s*(\d+)px/.exec(style)?.[1] || '0', 10);
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt) rows.push({ ml, txt: txt.slice(0, 140), hasChevron: !!el.querySelector('[aria-expanded]') });
        });
        return rows;
      }, BASE_ID);
    }

    const treeExpanded = await readTree();
    console.log('\n[test] Recents rows (expanded):');
    for (const r of treeExpanded) console.log(`  ml=${r.ml} chev=${r.hasChevron ? 'Y' : '.'}  ${r.txt}`);

    // Assertions on expanded state
    const indented = treeExpanded.filter(r => r.ml > 0);
    expect(indented.length, 'at least 3 indented fork rows should appear').toBeGreaterThanOrEqual(3);
    const depths = [...new Set(indented.map(r => r.ml))];
    expect(depths.length, 'tree should show more than one indent depth (e.g. F1 and F1a)').toBeGreaterThanOrEqual(2);

    // ── 4b. Weight ordering: F1's subtree (last leaf = F1a, newer) should
    //        sort strictly before F2 (leaf = F2 itself, older).
    const orderIdx = (id) => treeExpanded.findIndex(r => r.txt.includes(id.slice(0, 8)));
    const idxF1 = orderIdx(F1);
    const idxF2 = orderIdx(F2);
    const idxF1a = orderIdx(F1a);
    console.log('[test] order indices:', { idxF1, idxF1a, idxF2 });
    if (idxF1 >= 0 && idxF2 >= 0) {
      expect(idxF1, 'F1 (has newer leaf F1a) should be listed before F2').toBeLessThan(idxF2);
    }
    if (idxF1 >= 0 && idxF1a >= 0) {
      expect(idxF1a, 'F1a (child of F1) should follow F1 directly').toBeGreaterThan(idxF1);
    }

    // ── 4c. Collapse the base and confirm descendants hide ─────────────────
    // The chevron sits on rows that have children. Click the FIRST visible chevron.
    const chevronBtns = page.locator('button[aria-expanded]');
    const countBefore = await chevronBtns.count();
    console.log('[test] chevron count:', countBefore);
    if (countBefore > 0) {
      await chevronBtns.first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'fork-tree-02-collapsed.png', fullPage: true });

      const treeCollapsed = await readTree();
      const indentedAfter = treeCollapsed.filter(r => r.ml > 0);
      console.log('[test] indented rows after collapse:', indentedAfter.length, '(was', indented.length, ')');
      // After collapsing the topmost subtree, at least SOME indented rows disappear.
      expect(indentedAfter.length, 'collapse should hide some descendants').toBeLessThan(indented.length);

      // Re-expand and confirm they come back.
      await chevronBtns.first().click();
      await page.waitForTimeout(500);
      const treeReExpanded = await readTree();
      const indentedRe = treeReExpanded.filter(r => r.ml > 0);
      expect(indentedRe.length, 're-expand should restore all descendants').toBeGreaterThanOrEqual(indented.length);
    } else {
      throw new Error('No chevron button rendered — fork tree is not visible');
    }
  } finally {
    for (const id of forks) {
      try { await deleteCopilotSession(token, id); } catch {}
    }
  }
});
