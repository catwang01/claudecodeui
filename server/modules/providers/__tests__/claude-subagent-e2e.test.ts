// @vitest-environment node
/**
 * End-to-end regression test for the "empty messages" bug.
 *
 * Symptom: GET /api/sessions/:id/messages?projectName=subagents returned
 * { messages: [], total: 0 } (HTTP 200) for any project whose Claude Code
 * session had produced subagent transcripts.
 *
 * This test drives the real production chain, with no mocks:
 *   sessions-watcher entry: sessionSynchronizerService.synchronizeProviderFile()
 *     → claudeSessionSynchronizer.synchronizeFile()
 *     → projectsDb.claude_dir_name
 *     → projects.getSessionMessages()          (used by the messages route)
 *     → claudeAdapter.fetchHistory()           (exactly what the route calls)
 *
 * It therefore fails if the project dir name is derived from a subagent
 * transcript path, which yields the bogus name "subagents".
 *
 * Hermetic: HOME and DATABASE_PATH are redirected to a throwaway directory
 * *before* any module that reads them is imported, so nothing is written to the
 * real ~/.claude/projects (a running app watches that directory and would sync
 * our fixture into the real database) nor to the real app DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const tmpRoot = path.join(os.tmpdir(), `ccui-subagent-e2e-${runId}`);

// --- Isolation: must happen before the dynamic imports below. ---
// A live cloudcli instance watches the real ~/.claude/projects; a fixture placed
// there would be synchronized into its real database. Redirect HOME so both the
// synchronizer's CLAUDE_HOME and projects.getSessionMessages() stay in $TMPDIR.
process.env.HOME = tmpRoot;
if (process.platform === 'win32') process.env.USERPROFILE = tmpRoot;
process.env.DATABASE_PATH = path.join(tmpRoot, 'auth.db');

const fakeHome = tmpRoot;
// A plausible (never created) project cwd, as Claude Code reports it in JSONL.
const projectPath = `${fakeHome}/my_project`;
// Claude Code encodes the project path: every non-alphanumeric char becomes '-'.
const encodedDirName = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
const claudeProjectDir = path.join(fakeHome, '.claude', 'projects', encodedDirName);

const sessionId = `e2e-${runId}`;
const parentFile = path.join(claudeProjectDir, `${sessionId}.jsonl`);
const agentFile = path.join(
  claudeProjectDir,
  sessionId,
  'subagents',
  `agent-${runId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}.jsonl`
);

const PARENT_LINE_COUNT = 3;

function jsonlLine(text: string): string {
  return JSON.stringify({
    sessionId,
    cwd: projectPath,
    timestamp: new Date().toISOString(),
    uuid: Math.random().toString(36).slice(2),
    type: 'user',
    message: { role: 'user', content: text },
  });
}

let projectsDb: any;
let sessionsDb: any;
let sessionSynchronizerService: any;
let getSessionMessages: any;
let claudeAdapter: any;
let closeConnection: any;

const projectRow = () => projectsDb.getAllProjects().find((p: any) => p.project_path === projectPath);

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.mkdir(path.dirname(agentFile), { recursive: true });

  await fs.writeFile(
    parentFile,
    Array.from({ length: PARENT_LINE_COUNT }, (_, i) => jsonlLine(`parent message ${i}`)).join('\n') + '\n',
    'utf8'
  );
  await fs.writeFile(agentFile, jsonlLine('subagent message') + '\n', 'utf8');

  ({ projectsDb, sessionsDb } = await import('@/modules/database/index.js'));
  ({ closeConnection } = await import('@/modules/database/connection.js'));
  ({ sessionSynchronizerService } = await import('../services/session-synchronizer.service.js'));
  ({ getSessionMessages } = await import('../../../projects.js'));
  ({ claudeAdapter } = await import('../../../providers/claude/adapter.js'));

  // Guard: if HOME redirection did not take effect the test would silently read
  // the developer's real ~/.claude. Fail loudly instead.
  expect(os.homedir()).toBe(fakeHome);
});

afterAll(async () => {
  try { closeConnection?.(); } catch { /* ignore */ }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('subagent transcripts must not corrupt the project dir name (e2e)', () => {
  it('keeps the real project dir name and keeps returning messages', async () => {
    // 1. A real session file is synced first — establishes the correct name.
    expect(await sessionSynchronizerService.synchronizeProviderFile('claude', parentFile)).toBe(sessionId);
    expect(projectRow()?.claude_dir_name).toBe(encodedDirName);

    // 2. The watcher then fires for the subagent transcript (this is the bug path).
    expect(await sessionSynchronizerService.synchronizeProviderFile('claude', agentFile)).toBeNull();

    // 3. The persisted name must be unchanged — not "subagents".
    expect(projectRow()?.claude_dir_name).toBe(encodedDirName);

    // 4. Walk the same steps the messages route takes and assert non-empty output.
    const projectName = projectRow().claude_dir_name;
    const raw = await getSessionMessages(projectName, sessionId, null, 0);
    expect(Array.isArray(raw) ? raw : raw.messages).toHaveLength(PARENT_LINE_COUNT);

    const adapterResult = await claudeAdapter.fetchHistory(sessionId, { projectName, limit: null, offset: 0 });
    expect(adapterResult.messages.length).toBeGreaterThan(0);

    // 5. Documents the reported symptom (not a regression gate on its own:
    //    with a unique sessionId this is empty regardless of the guard).
    const bogus = await claudeAdapter.fetchHistory(sessionId, { projectName: 'subagents', limit: null, offset: 0 });
    expect(bogus.messages).toHaveLength(0);
  });

  it('still registers a normal session — the guard is not over-broad', async () => {
    const row = sessionsDb.getSessionById(sessionId);
    expect(row).toBeTruthy();
    expect(row.project_path).toBe(projectPath);
    expect(projectRow()?.claude_dir_name).toBe(encodedDirName);
  });
});
