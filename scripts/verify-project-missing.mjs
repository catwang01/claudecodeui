#!/usr/bin/env node
/**
 * End-to-end acceptance check for issue #16: projects whose directory no longer exists.
 *
 * Boots the real server (tsx) on a throwaway port with:
 *   - DATABASE_PATH  → temp SQLite file (never the live app DB)
 *   - HOME           → temp dir (so ~/.claude/projects and ~/.codex are temp, and the running
 *                      production server never sees the probe session files)
 *
 * Then it exercises the HTTP + WebSocket surface:
 *   1. missing directory  → still listed, availability.status='missing', /files 404 PROJECT_PATH_MISSING
 *   2. permission failure → still available, reason='permission_denied', /files 403 PROJECT_PATH_UNREADABLE
 *   3. archive endpoint   → non-destructive + idempotent + 404 for unknown project
 *   4. sticky archive     → a synchronizer re-scan must NOT resurrect the archived project
 *   5. file-tree DELETE   → archives a project rooted inside the deleted directory
 *   6. WS broadcast       → DELETE /api/projects/:name invalidates the cached list (no stale project)
 *
 * Usage: /path/to/node-v22/bin/node scripts/verify-project-missing.mjs
 * Exit code 0 = all checks passed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// better-sqlite3 ships a native binding compiled for Node 22 (see .nvmrc). Force the Node 22
// bin dir onto PATH for the spawned server when the active node is newer (Node 24 ABI mismatch).
function resolveNodeBinDir() {
  if (process.env.E2E_NODE_BIN) return process.env.E2E_NODE_BIN;
  const nvmBin = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.17.0', 'bin');
  if (fs.existsSync(path.join(nvmBin, 'node'))) return nvmBin;
  return null;
}

const NODE_BIN_DIR = resolveNodeBinDir();
if (NODE_BIN_DIR) console.log('[e2e] using node bin dir: ' + NODE_BIN_DIR + ' (current: ' + process.version + ')');
else if (!process.version.startsWith('v22')) console.warn('[e2e] WARNING: no Node 22 bin dir found; better-sqlite3 may fail under ' + process.version);

const PORT = Number(process.env.E2E_PORT || 3488);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'project-missing-e2e-'));
const DB_PATH = path.join(TMP, 'auth.db');
// Pre-create the temp DB so the server bootstrap does not migrate the repository's
// server/database/auth.db (stale rows from previous test runs) into this run.
fs.writeFileSync(DB_PATH, '');
const HOME_DIR = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME_DIR, '.claude', 'projects'), { recursive: true });
const CLAUDE_PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const PROJECTS_ROOT = path.join(TMP, 'projects');
fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
const USER = { username: 'e2euser', password: 'e2e-password' };

let token = null;
let child = null;
let passed = 0;
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, fn) {
  try {
    const out = fn();
    passed += 1;
    console.log('  PASS  ' + name + (out === undefined ? '' : '  -> ' + out));
  } catch (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + '  -> ' + err.message);
  }
}

async function checkAsync(name, fn) {
  try {
    const out = await fn();
    passed += 1;
    console.log('  PASS  ' + name + (out === undefined ? '' : '  -> ' + out));
  } catch (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + '  -> ' + err.message);
  }
}

async function poll(label, fn, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
}

function startServer() {
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(PORT),
    PORT: String(PORT),
    DATABASE_PATH: DB_PATH,
    HOME: HOME_DIR,
    NODE_ENV: 'production',
    SCHEDULED_TASKS_ENABLED: '0',
  };
  const proc = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.js'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = path.join(TMP, 'server.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  proc.stdout.pipe(stream);
  proc.stderr.pipe(stream);
  proc.on('exit', (code) => stream.write('\n[server exited ' + code + ']\n'));
  return { proc, logPath };
}

async function stopServer() {
  if (!child) return;
  const proc = child.proc;
  child = null;
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  for (let i = 0; i < 50 && proc.exitCode === null; i += 1) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

function tailLog(lines = 25) {
  if (!child) return '(no server)';
  try {
    return fs.readFileSync(child.logPath, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(unreadable log)';
  }
}

async function waitForHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt';
  while (Date.now() < deadline) {
    if (child && child.proc.exitCode !== null) {
      throw new Error('server exited early (code ' + child.proc.exitCode + '); log: ' + tailLog());
    }
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
      lastErr = 'status ' + res.status;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(400);
  }
  throw new Error('server not healthy after ' + timeoutMs + 'ms (' + lastErr + '); log: ' + tailLog());
}

async function api(method, url, body, expect) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(method + ' ' + url + ' expected HTTP ' + expect + ' got ' + res.status + ' body=' + text.slice(0, 300));
  }
  return { status: res.status, json, text };
}

async function listProjects() {
  return (await api('GET', '/api/projects', undefined, 200)).json;
}

function findProject(projects, dirPath) {
  return projects.find((project) => project.path === dirPath || project.fullPath === dirPath) || null;
}

async function projectApiName(dirPath) {
  const project = await poll('project ' + path.basename(dirPath) + ' in /api/projects', async () => {
    const projects = await listProjects();
    return findProject(projects, dirPath);
  });
  return project.name;
}

async function registerProject(dirPath) {
  const { json } = await api('POST', '/api/projects/create', { path: dirPath }, 200);
  assert(json?.success === true, 'create did not return success: ' + JSON.stringify(json));
  return json.project;
}

function encodedProjectName(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function writeProbeSession(sessionId, projectPath, fileName) {
  const dir = path.join(CLAUDE_PROJECTS_DIR, encodedProjectName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    sessionId,
    cwd: projectPath,
    type: 'user',
    uuid: 'e2e-' + sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'probe' },
  });
  fs.writeFileSync(path.join(dir, fileName), line + '\n', 'utf8');
  return dir;
}

function openDb() {
  return new Database(DB_PATH);
}

async function main() {
  console.log('[e2e] temp dir:', TMP);
  console.log('[e2e] temp HOME:', HOME_DIR);
  console.log('[e2e] db:', DB_PATH);
  child = startServer();
  await waitForHealth();

  await checkAsync('auth bootstrap + register', async () => {
    const status = await api('GET', '/api/auth/status', undefined, 200);
    assert(status.json.needsSetup === true, 'expected needsSetup=true');
    const registered = await api('POST', '/api/auth/register', USER, 200);
    assert(registered.json.token, 'no token');
    token = registered.json.token;
  });

  // ── 1. missing directory ────────────────────────────────────────────────────
  const missingDir = path.join(PROJECTS_ROOT, 'missing-target');
  fs.mkdirSync(missingDir, { recursive: true });
  await registerProject(missingDir);
  const missingName = await projectApiName(missingDir);

  await checkAsync('existing directory is reported available', async () => {
    const project = findProject(await listProjects(), missingDir);
    assert(project, 'project not listed');
    assert(project.availability?.status === 'available', 'expected available, got ' + JSON.stringify(project.availability));
  });

  await checkAsync('POST /api/projects/create response carries availability', async () => {
    const dir = path.join(PROJECTS_ROOT, 'create-response');
    fs.mkdirSync(dir, { recursive: true });
    const project = await registerProject(dir);
    assert(project?.availability?.status === 'available', 'create response missing availability: ' + JSON.stringify(project?.availability));
    assert(project.availability.readable === true, 'expected readable=true');
  });

  fs.rmSync(missingDir, { recursive: true, force: true });

  await checkAsync('deleted directory stays listed but becomes missing (never hidden)', async () => {
    const project = await poll('availability missing', async () => {
      const entry = findProject(await listProjects(), missingDir);
      return entry && entry.availability?.status === 'missing' ? entry : null;
    });
    assert(project.availability.available === false, 'expected available=false');
    assert(project.availability.reason === 'not_found', 'expected reason not_found, got ' + project.availability.reason);
    assert(project.availability.errorCode === 'ENOENT', 'expected ENOENT, got ' + project.availability.errorCode);
  });

  await checkAsync('GET /files returns 404 PROJECT_PATH_MISSING for a missing directory', async () => {
    const res = await api('GET', '/api/projects/' + missingName + '/files');
    assert(res.status === 404, 'expected 404, got ' + res.status);
    assert(res.json.code === 'PROJECT_PATH_MISSING', 'expected PROJECT_PATH_MISSING, got ' + res.json.code);
    assert(res.json.availability?.status === 'missing', 'availability not echoed');
  });

  // ── 2. permission failure is NOT missing ────────────────────────────────────
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  SKIP  permission check (running as root)');
  } else {
    const lockedParent = path.join(PROJECTS_ROOT, 'locked');
    const lockedDir = path.join(lockedParent, 'child');
    fs.mkdirSync(lockedDir, { recursive: true });
    await registerProject(lockedDir);
    const lockedName = await projectApiName(lockedDir);
    fs.chmodSync(lockedParent, 0o000);

    await checkAsync('EACCES keeps the project available but reports permission_denied', async () => {
      const project = await poll('permission_denied availability', async () => {
        const entry = findProject(await listProjects(), lockedDir);
        return entry && entry.availability?.reason === 'permission_denied' ? entry : null;
      });
      assert(project.availability.available === true, 'EACCES must NOT mark the project missing');
      assert(project.availability.status === 'available', 'expected status available');
      assert(project.availability.readable === false, 'expected readable=false');
      assert(project.availability.errorCode === 'EACCES', 'expected EACCES, got ' + project.availability.errorCode);
    });

    await checkAsync('GET /files returns 403 PROJECT_PATH_UNREADABLE (not 404) on EACCES', async () => {
      const res = await api('GET', '/api/projects/' + lockedName + '/files');
      assert(res.status === 403, 'expected 403, got ' + res.status + ' body=' + res.text.slice(0, 200));
      assert(res.json.code === 'PROJECT_PATH_UNREADABLE', 'expected PROJECT_PATH_UNREADABLE, got ' + res.json.code);
    });

    fs.chmodSync(lockedParent, 0o755);
  }

  // ── 3. sticky archive + synchronizer re-scan ────────────────────────────────
  const syncDir = path.join(PROJECTS_ROOT, 'sync-target');
  fs.mkdirSync(syncDir, { recursive: true });
  const syncProbeDir = writeProbeSession('e2e-sync-s1', syncDir, 'probe1.jsonl');
  const syncName = await projectApiName(syncDir);

  await checkAsync('session synchronizer registered the probe project', async () => {
    const project = findProject(await listProjects(), syncDir);
    assert(project, 'probe project not listed');
    assert(project.name === syncName, 'unexpected project name');
  });

  await checkAsync('POST /archive is non-destructive and hides the project', async () => {
    const res = await api('POST', '/api/projects/' + syncName + '/archive', {}, 200);
    assert(res.json.archived === true, 'expected archived=true');
    assert(res.json.alreadyArchived === false, 'expected alreadyArchived=false');
    assert(fs.existsSync(path.join(syncProbeDir, 'probe1.jsonl')), 'session file was deleted by archive!');
    const projects = await listProjects();
    assert(!findProject(projects, syncDir), 'archived project still listed');
  });

  await checkAsync('POST /archive is idempotent (200 + alreadyArchived)', async () => {
    const res = await api('POST', '/api/projects/' + syncName + '/archive', {}, 200);
    assert(res.json.archived === false, 'expected archived=false on second call');
    assert(res.json.alreadyArchived === true, 'expected alreadyArchived=true');
  });

  await checkAsync('POST /archive returns 404 PROJECT_NOT_FOUND for an unknown project', async () => {
    const res = await api('POST', '/api/projects/definitely-not-a-project-xyz/archive', {}, 404);
    assert(res.json.code === 'PROJECT_NOT_FOUND', 'expected PROJECT_NOT_FOUND, got ' + res.json.code);
  });

  await checkAsync('a synchronizer re-scan does NOT resurrect the archived project', async () => {
    // Second probe file → chokidar 'add' → synchronizeFile → projectsDb.createProjectPath(syncDir)
    writeProbeSession('e2e-sync-s2', syncDir, 'probe2.jsonl');

    const db = openDb();
    try {
      await poll('session e2e-sync-s2 synced into the temp DB', async () => {
        const row = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get('e2e-sync-s2');
        return row || null;
      }, { timeoutMs: 20000 });
      const projectRow = db.prepare('SELECT isArchived FROM projects WHERE project_path = ?').get(syncDir);
      assert(projectRow, 'project row missing');
      assert(projectRow.isArchived === 1, 'archived row was resurrected by the synchronizer (isArchived=' + projectRow.isArchived + ')');
      const sessionRows = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_path = ?').get(syncDir);
      assert(sessionRows.n >= 2, 'expected the re-scan to record sessions, got ' + sessionRows.n);
    } finally {
      db.close();
    }

    const projects = await listProjects();
    assert(!findProject(projects, syncDir), 'resurrected project is listed again');
  });

  // ── 4. file-tree DELETE archives matching projects ─────────────────────────
  const treeRoot = path.join(PROJECTS_ROOT, 'tree');
  const treeChild = path.join(treeRoot, 'child');
  fs.mkdirSync(treeChild, { recursive: true });
  await registerProject(treeRoot);
  await registerProject(treeChild);
  const treeRootName = await projectApiName(treeRoot);
  await projectApiName(treeChild);

  await checkAsync('file-tree DELETE of a subdirectory archives the project rooted there', async () => {
    const res = await api('DELETE', '/api/projects/' + treeRootName + '/files', { path: treeChild, type: 'directory' }, 200);
    assert(Array.isArray(res.json.archivedProjects), 'archivedProjects missing');
    assert(res.json.archivedProjects.includes(treeChild), 'child path not archived: ' + JSON.stringify(res.json.archivedProjects));
    const projects = await listProjects();
    assert(!findProject(projects, treeChild), 'child project still listed');
    assert(findProject(projects, treeRoot), 'parent project must stay listed (its directory still exists)');
  });

  // ── 5. WS broadcast after DELETE project (cache invalidation) ──────────────
  const wsDir = path.join(PROJECTS_ROOT, 'ws-target');
  fs.mkdirSync(wsDir, { recursive: true });
  await registerProject(wsDir);
  const wsName = await projectApiName(wsDir);
  await listProjects(); // warm _cachedProjectsList server-side

  const wsMessages = [];
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws?token=' + encodeURIComponent(token || ''));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 15000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  ws.on('message', (data) => {
    try { wsMessages.push(JSON.parse(String(data))); } catch { /* ignore */ }
  });

  await checkAsync('DELETE /api/projects/:name broadcasts a fresh list without the project', async () => {
    await api('DELETE', '/api/projects/' + wsName + '?force=true', undefined, 200);
    const message = await poll('projects_updated without ' + wsName, async () => {
      return wsMessages.find((entry) => entry.type === 'projects_updated'
        && Array.isArray(entry.projects)
        && !entry.projects.some((project) => project.name === wsName)) || null;
    }, { timeoutMs: 20000 });
    assert(message, 'no fresh broadcast received');
    const projects = await listProjects();
    assert(!projects.some((project) => project.name === wsName), 'deleted project still in GET /api/projects');
  });

  await checkAsync('POST /archive broadcasts a list without the archived project (WS no resurrection)', async () => {
    const dir = path.join(PROJECTS_ROOT, 'archive-ws');
    fs.mkdirSync(dir, { recursive: true });
    await registerProject(dir);
    const name = await projectApiName(dir);
    await listProjects(); // warm the cached list so the broadcast has to rebuild

    wsMessages.length = 0;
    const res = await api('POST', '/api/projects/' + name + '/archive', {}, 200);
    assert(res.json.archived === true, 'expected archived=true, got ' + JSON.stringify(res.json));

    const message = await poll('projects_updated without ' + name, async () => {
      return wsMessages.find((entry) => entry.type === 'projects_updated'
        && Array.isArray(entry.projects)
        && !entry.projects.some((project) => project.name === name || project.path === dir)) || null;
    }, { timeoutMs: 20000 });
    assert(message, 'no fresh broadcast received after archive');

    const projects = await listProjects();
    assert(!findProject(projects, dir), 'archived project still in GET /api/projects');
  });

  // ── 6. realpath aliases: /var vs /private/var (verifier F1/F2) ────────────
  const projectsRootReal = fs.realpathSync(PROJECTS_ROOT);
  if (projectsRootReal !== PROJECTS_ROOT) {
    await checkAsync('archiving one spelling also archives the /private/var alias row', async () => {
      const aliasDir = path.join(PROJECTS_ROOT, 'alias-target');
      const realDir = path.join(projectsRootReal, 'alias-target');
      fs.mkdirSync(aliasDir, { recursive: true });
      await registerProject(aliasDir);
      await registerProject(realDir);
      // Two spellings of one real directory currently produce two rows (documented in
      // docs/project-directory-availability.md §2.1 — we do NOT dedupe the list because
      // sessions.project_path is bound per spelling).
      await poll('both alias spellings listed', async () => {
        const list = await listProjects();
        return findProject(list, aliasDir) && findProject(list, realDir) ? true : null;
      }, { timeoutMs: 15000 });
      const aliasName = await projectApiName(aliasDir);

      const first = await api('POST', '/api/projects/' + aliasName + '/archive', {}, 200);
      assert(first.json.archived === true, 'expected archived=true, got ' + JSON.stringify(first.json));
      const archivedPaths = first.json.archivedPaths ?? [];
      assert(archivedPaths.includes(aliasDir), 'alias spelling not archived: ' + JSON.stringify(archivedPaths));
      assert(archivedPaths.includes(realDir), 'real spelling not archived: ' + JSON.stringify(archivedPaths));

      await poll('both alias spellings removed from /api/projects', async () => {
        const list = await listProjects();
        return list.some((p) => p.path === aliasDir || p.path === realDir) ? null : true;
      });

      const second = await api('POST', '/api/projects/' + aliasName + '/archive', {}, 200);
      assert(second.json.alreadyArchived === true, 'expected alreadyArchived=true on the second call');
    });
  } else {
    console.log('  SKIP  alias check (no /var -> /private/var symlink on this filesystem)');
  }

  // ── 6b. lossy names: x_y vs x/y must fail closed, never archive the wrong dir (A4) ──
  await checkAsync('lossy name (x_y vs x/y) fails closed with 409 and archives nothing', async () => {
    const collisionRoot = path.join(PROJECTS_ROOT, 'name-collision');
    const underscoreDir = path.join(collisionRoot, 'x_y');
    const slashDir = path.join(collisionRoot, 'x', 'y');
    fs.mkdirSync(underscoreDir, { recursive: true });
    fs.mkdirSync(slashDir, { recursive: true });
    await registerProject(underscoreDir);
    await registerProject(slashDir);

    const name = await projectApiName(underscoreDir);
    const slashName = await projectApiName(slashDir);
    assert(name === slashName, 'expected x_y and x/y to share one encoded name, got ' + name + ' vs ' + slashName);

    const ambiguous = await api('POST', '/api/projects/' + name + '/archive', {}, 409);
    assert(ambiguous.json.code === 'PROJECT_NAME_AMBIGUOUS', 'expected PROJECT_NAME_AMBIGUOUS, got ' + ambiguous.json.code);
    const candidates = ambiguous.json.candidatePaths ?? [];
    assert(candidates.includes(underscoreDir) && candidates.includes(slashDir), 'candidatePaths missing a candidate: ' + JSON.stringify(candidates));

    const untouched = await listProjects();
    assert(findProject(untouched, underscoreDir), 'ambiguous call archived the x_y project');
    assert(findProject(untouched, slashDir), 'ambiguous call archived the x/y project');

    // The sidebar sends the exact path: that archives only the requested directory.
    const exact = await api('POST', '/api/projects/' + name + '/archive', { path: underscoreDir }, 200);
    assert(exact.json.ambiguous !== true, 'exact-path archive was reported ambiguous');
    assert(exact.json.archived === true, 'expected archived=true, got ' + JSON.stringify(exact.json));
    assert((exact.json.archivedPaths ?? []).includes(underscoreDir), 'underscore dir not archived');
    assert(!(exact.json.archivedPaths ?? []).includes(slashDir), 'unrelated x/y dir was archived');

    const after = await listProjects();
    assert(!findProject(after, underscoreDir), 'x_y project still listed after exact archive');
    assert(findProject(after, slashDir), 'x/y project was removed by the exact archive');
  });

  // ── 7. verifier blocker: removing the last projects must not resurrect them ─
  await checkAsync('archiving every active project leaves an empty list (no legacy resurrection)', async () => {
    await listProjects(); // warm the cached list / WS state
    wsMessages.length = 0;
    for (const project of await listProjects()) {
      await api('POST', '/api/projects/' + project.name + '/archive', {}, 200);
    }

    // The last archive must broadcast an EMPTY project list: if the legacy filesystem
    // fallback resurrected archived projects, the broadcast would contain them again.
    const emptyBroadcast = await poll('projects_updated with an empty project list', async () => {
      return wsMessages.find((entry) => entry.type === 'projects_updated'
        && Array.isArray(entry.projects)
        && entry.projects.length === 0) || null;
    }, { timeoutMs: 20000 });
    assert(emptyBroadcast, 'no empty projects_updated broadcast (legacy resurrection?)');

    await poll('empty /api/projects', async () => {
      const list = await listProjects();
      return list.length === 0 ? true : null;
    }, { timeoutMs: 15000 });

    // A fresh active project must not drag the archived ones back in (verifier repro:
    // "再注册活跃 c 后两者又消失" / "移除最后一个项目后它不会回来").
    const freshDir = path.join(PROJECTS_ROOT, 'fresh-after-archive');
    fs.mkdirSync(freshDir, { recursive: true });
    await registerProject(freshDir);

    const after = await poll('only the fresh project is listed', async () => {
      const list = await listProjects();
      return list.length === 1 && findProject(list, freshDir) ? list : null;
    }, { timeoutMs: 15000 });
    assert(after.length === 1, 'expected only the fresh project, got ' + after.map((p) => p.path).join(', '));
  });

  ws.close();
  console.log('');
  console.log('[e2e] server log tail:');
  console.log(tailLog(12));
}

try {
  await main();
} catch (err) {
  failures.push('fatal: ' + err.message);
  console.log('  FAIL  fatal  -> ' + err.message);
} finally {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('');
  console.log('[e2e] passed=' + passed + ' failed=' + failures.length);
  if (failures.length) {
    for (const failure of failures) console.log('  - ' + failure);
    process.exit(1);
  }
  console.log('[e2e] ALL CHECKS PASSED');
  process.exit(0);
}
