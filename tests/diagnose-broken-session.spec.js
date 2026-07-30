/**
 * Diagnostic Playwright script: open the reported broken session in the browser,
 * capture what the UI actually renders (headed screenshot + DOM snapshot), and
 * dump every network response so we can compare against what the REST API is
 * really returning.
 */
import { test } from '@playwright/test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import path from 'path';
import os from 'os';

const SESSION_ID = process.env.SESSION_ID || '1692d19f-682a-4d06-a61c-d3023793c560';
const APP_URL   = process.env.APP_URL   || 'http://localhost:5201';
const DB_PATH   = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli2', 'auth.db');

function issueToken() {
  const db = new Database(DB_PATH);
  const secret = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
  const user = db.prepare('SELECT id, username FROM users LIMIT 1').get();
  db.close();
  return jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '30m' });
}

test.setTimeout(120_000);

test('diagnose broken session render', async ({ page, context }) => {
  const token = issueToken();

  await context.addInitScript((t) => {
    window.localStorage.setItem('auth-token', t);
  }, token);

  const netEvents = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/sessions/') && url.includes('/messages')) {
      let body;
      try { body = await resp.text(); } catch { body = '<unreadable>'; }
      netEvents.push({ url, status: resp.status(), bodySize: body.length, body: body.slice(0, 4000) });
    }
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/error|warn|copilot|session/i.test(t)) console.log('[browser]', t.slice(0, 250));
  });

  await page.goto(`${APP_URL}/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(4500);

  await page.screenshot({ path: 'diag-01-full.png', fullPage: true });

  // Snapshot the chat area DOM structure.
  const chatDump = await page.evaluate(() => {
    // Try common chat selectors
    const candidates = [
      '[data-testid="chat-messages"]',
      '[data-role="chat"]',
      'main [role="log"]',
      'main',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const items = [];
      el.querySelectorAll('[data-message-id], [data-testid^="message-"], .message, [class*="Message"]').forEach((n, idx) => {
        items.push({
          idx,
          tag: n.tagName,
          cls: (n.className || '').toString().slice(0, 200),
          textLen: (n.textContent || '').length,
          textPreview: (n.textContent || '').replace(/\s+/g, ' ').slice(0, 180),
        });
      });
      if (items.length > 0) return { selector: sel, count: items.length, items };
    }
    // Fallback: raw text from body
    return {
      selector: 'body-fallback',
      bodyText: document.body.innerText.slice(0, 5000),
    };
  });

  console.log('\n──── UI SNAPSHOT ────');
  console.log(JSON.stringify(chatDump, null, 2));

  console.log('\n──── NETWORK (messages endpoints) ────');
  for (const e of netEvents) {
    console.log(`${e.status}  ${e.url}  bodySize=${e.bodySize}`);
    console.log('  body[0..2000]:', e.body.slice(0, 2000));
  }
});
