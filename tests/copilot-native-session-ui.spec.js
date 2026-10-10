import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import os from 'os';
import path from 'path';

const APP_URL = process.env.APP_URL || 'http://localhost:5201';
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli2', 'auth.db');

test.describe('Copilot native session UI', () => {
  const sessionId = `copilot-ui-${crypto.randomUUID()}`;
  const projectId = `project-${crypto.randomUUID()}`;
  const projectPath = path.join(os.tmpdir(), `copilot-ui-project-${crypto.randomUUID()}`);
  const sessionDir = path.join(os.homedir(), '.copilot', 'session-state', sessionId);
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const sessionTitle = 'Copilot native events UI test';
  const userMessage = 'Read this message from Copilot native events.';
  const assistantMessage = 'This response came from the native Copilot session.';
  let token;

  test.beforeAll(() => {
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(eventsPath, [
      {
        type: 'session.start',
        id: 'session-start',
        timestamp: '2026-10-09T20:00:00.000Z',
        data: { sessionId },
      },
      {
        type: 'user.message',
        id: 'native-user-message',
        timestamp: '2026-10-09T20:00:01.000Z',
        data: { content: userMessage },
      },
      {
        type: 'assistant.message',
        id: 'native-assistant-message',
        timestamp: '2026-10-09T20:00:02.000Z',
        data: { content: assistantMessage },
      },
    ].map((event) => JSON.stringify(event)).join('\n'), 'utf8');

    const db = new Database(DB_PATH);
    const secret = db.prepare("SELECT value FROM app_config WHERE key = 'jwt_secret'").get()?.value;
    const user = db.prepare(
      'SELECT id, username FROM users WHERE is_active = 1 ORDER BY id LIMIT 1'
    ).get();
    if (!secret || !user) {
      db.close();
      throw new Error(`UI test requires an initialized CloudCLI database at ${DB_PATH}`);
    }

    db.prepare(
      `INSERT INTO projects (
         project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived
       ) VALUES (?, ?, ?, ?, 0, 0)`
    ).run(projectId, projectPath, 'Copilot Native UI Project', null);
    db.prepare(
      `INSERT INTO sessions (
         session_id, provider, provider_session_id, custom_name, project_path,
         jsonl_path, isArchived, created_at, updated_at
       ) VALUES (?, 'copilot', ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      sessionId,
      sessionId,
      sessionTitle,
      projectPath,
      eventsPath,
      '2026-10-09T20:00:00.000Z',
      '2026-10-09T20:00:02.000Z'
    );
    db.close();

    token = jwt.sign(
      { userId: user.id, username: user.username },
      secret,
      { expiresIn: '30m' }
    );
  });

  test.afterAll(() => {
    const db = new Database(DB_PATH);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
    db.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
    try {
      fs.rmSync(projectPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EBUSY') throw error;
    }
  });

  test('opens a Copilot session and renders its native event history', async ({ page, context }) => {
    await context.addInitScript((authToken) => {
      window.localStorage.setItem('auth-token', authToken);
    }, token);

    const historyResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/sessions/${sessionId}/messages`;
    });

    await page.goto(`${APP_URL}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });

    const historyResponse = await historyResponsePromise;
    expect(historyResponse.ok()).toBe(true);
    expect(new URL(historyResponse.url()).searchParams.get('provider')).toBe('copilot');
    await expect(page.getByText(userMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(assistantMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(sessionTitle, { exact: true }).first()).toBeVisible();
  });

  test('refreshes Copilot history after returning from Shell to Chat', async ({ page, context }) => {
    await context.addInitScript((authToken) => {
      window.localStorage.setItem('auth-token', authToken);
    }, token);

    await page.goto(`${APP_URL}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(assistantMessage, { exact: true })).toBeVisible();

    await page.getByText('Shell', { exact: true }).click();

    const shellUserMessage = 'Continue this conversation from Shell.';
    const shellAssistantMessage = 'This response was appended by the Shell session.';
    fs.appendFileSync(eventsPath, [
      {
        type: 'session.resume',
        id: 'shell-session-resume',
        timestamp: '2026-10-09T20:01:00.000Z',
        data: { sessionId },
      },
      {
        type: 'user.message',
        id: 'shell-user-message',
        timestamp: '2026-10-09T20:01:01.000Z',
        data: { content: shellUserMessage },
      },
      {
        type: 'assistant.message',
        id: 'shell-assistant-message',
        timestamp: '2026-10-09T20:01:02.000Z',
        data: { content: shellAssistantMessage },
      },
    ].map((event) => JSON.stringify(event)).join('\n').replace(/^/, '\n'), 'utf8');

    await page.getByText('Chat', { exact: true }).click();

    await expect(page.getByText(shellUserMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(shellAssistantMessage, { exact: true })).toBeVisible();
  });
});
