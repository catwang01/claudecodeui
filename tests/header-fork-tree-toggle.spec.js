/**
 * The Show fork tree toggle moved from the Recents tab body into the sidebar
 * header (next to the refresh button). This test confirms:
 *   1. The toggle exists in the header (visible in Projects tab, not just Recents).
 *   2. Clicking it toggles both Recents' AND Projects' view of forked sessions
 *      (flat vs indented).
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

const APP_URL = process.env.APP_URL || 'http://localhost:5201';
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli2', 'auth.db');
const BASE_ID = process.env.BASE_ID || '1692d19f-682a-4d06-a61c-d3023793c560';
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
  if (!resp.ok) throw new Error(`fork HTTP ${resp.status}`);
  return (await resp.json()).newSessionId;
}

async function cleanup(token, sessionId) {
  const jsonl = path.join(os.homedir(), '.claude', 'projects', PROJECT, `${sessionId}.jsonl`);
  await fs.unlink(jsonl).catch(() => {});
  const db = new Database(DB_PATH);
  try {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_fork_parents WHERE fork_session_id = ? OR parent_session_id = ?').run(sessionId, sessionId);
  } finally { db.close(); }
}

const countIndented = () => document.querySelectorAll('.group[style*="margin-left"]').length;

test.setTimeout(240_000);

test('header toggle controls fork tree in both Projects and Recents', async ({ page, context }) => {
  const token = issueToken();
  const forks = [];

  try {
    forks.push(await callFork(token, BASE_ID));
    await new Promise((r) => setTimeout(r, 300));
    forks.push(await callFork(token, BASE_ID));
    await new Promise((r) => setTimeout(r, 300));
    forks.push(await callFork(token, forks[0])); // F1a under F1

    await context.addInitScript((t) => {
      window.localStorage.setItem('auth-token', t);
      // Force fork-tree ON at start so we have a known baseline.
      window.localStorage.setItem('sidebar-fork-tree-mode', 'true');
    }, token);

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // The header toggle is a GitFork icon button that is visible right now
    // (even in the Projects tab), unlike the old in-body toggle.
    const headerToggle = page.locator('button[aria-pressed][title*="fork tree" i], button[aria-pressed][title*="Fork" i], button[aria-pressed][title*="Fork 树"]').first();
    await expect(headerToggle, 'header fork tree toggle should be present').toBeVisible({ timeout: 10_000 });

    // Expand the claudecodeui project so we can observe indentation.
    await page.getByPlaceholder(/Search projects/i).first().fill('claudecodeui2');
    await page.waitForTimeout(600);
    const projectContainer = page.locator(`[data-project-name="${PROJECT}"]`).first();
    await expect(projectContainer).toBeVisible({ timeout: 10_000 });
    await projectContainer.locator('button.w-full').first().click();
    await page.waitForTimeout(2000);

    const indentedWithTreeOn = await page.evaluate(countIndented);
    console.log('[test] projects indented rows (tree on):', indentedWithTreeOn);
    expect(indentedWithTreeOn, 'projects tab shows indented fork rows when toggle is on').toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: 'header-toggle-01-on-projects.png', fullPage: true });

    // Flip the header toggle off.
    await headerToggle.click();
    await page.waitForTimeout(600);
    const indentedWithTreeOff = await page.evaluate(countIndented);
    console.log('[test] projects indented rows (tree off):', indentedWithTreeOff);
    expect(indentedWithTreeOff, 'projects flattens when toggle is off').toBe(0);
    await page.screenshot({ path: 'header-toggle-02-off-projects.png', fullPage: true });

    // Flip back on so Recents also observes the flip.
    await headerToggle.click();
    await page.waitForTimeout(500);

    // Switch to Recents tab; the same header toggle still lives there, and the
    // recents view should show forks indented. Clear the projects search box
    // first so Recents doesn't jump into conversation-search mode.
    await page.getByPlaceholder(/Search projects/i).first().fill('');
    await page.getByRole('button', { name: /^Recent$/i }).first().click();
    await page.waitForTimeout(1500);
    const indentedRecentsOn = await page.evaluate(countIndented);
    console.log('[test] recents indented rows (tree on):', indentedRecentsOn);
    expect(indentedRecentsOn, 'recents shows indented forks when toggle is on').toBeGreaterThanOrEqual(3);

    // Flip off from Recents; recents flattens.
    await headerToggle.click();
    await page.waitForTimeout(500);
    const indentedRecentsOff = await page.evaluate(countIndented);
    console.log('[test] recents indented rows (tree off):', indentedRecentsOff);
    expect(indentedRecentsOff, 'recents flattens when toggle is off').toBe(0);
    await page.screenshot({ path: 'header-toggle-03-off-recents.png', fullPage: true });
  } finally {
    for (const id of forks) { try { await cleanup(token, id); } catch {} }
  }
});
