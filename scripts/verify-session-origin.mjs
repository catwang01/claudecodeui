#!/usr/bin/env node
/**
 * Acceptance check for scheduled-task session origin + hide/show (lead-owned).
 *
 * Proves, against a real temp SQLite database:
 *   - the session_id index exists on scheduled_task_runs
 *   - getSessionOrigins / getAllScheduledTaskSessionIds behave as contracted
 *   - applyScheduledTaskOrigin decorates session objects
 *   - filterHiddenScheduledTaskSessions hides them by default and keeps them when
 *     app_config.scheduled_task_hide_sessions = 'false'
 *   - buildExcludedSessionIds() reflects the same decision
 *
 * Usage (Node 22, --tsconfig is required for the "@/" aliases):
 *   npx tsx --tsconfig server/tsconfig.json scripts/verify-session-origin.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-origin-'));
process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.SCHEDULED_TASKS_ENABLED = '0';

const url = (rel) => new URL('../' + rel, import.meta.url).href;

let passed = 0;
const failures = [];
const assert = (cond, message) => { if (!cond) throw new Error(message); };

async function check(name, fn) {
  try {
    const out = await fn();
    passed += 1;
    console.log('  PASS  ' + name + (out === undefined ? '' : '  -> ' + out));
  } catch (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + '  -> ' + err.message);
  }
}

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_OLD = '33333333-3333-4333-8333-333333333333';
const SESSION_DOOMED = '44444444-4444-4444-8444-444444444444';

async function main() {
  console.log('[origin-e2e] temp dir: ' + TMP);
  await import(url('server/database/db.js')); // migrations on the temp DB
  const { scheduledTasksDb, appConfigDb } = await import(url('server/modules/database/index.js'));
  const { applyScheduledTaskOrigin, filterHiddenScheduledTaskSessions } = await import(url('server/database/db.js'));
  const { buildExcludedSessionIds } = await import(url('server/projects.js'));

  const iso = (ms) => new Date(ms).toISOString();
  const NOW = Date.now();

  const taskA = scheduledTasksDb.createTask({
    title: 'Nightly review', prompt: 'p', projectPath: TMP, provider: 'claude',
    kind: 'interval', ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 300 }),
    nextRunAt: iso(NOW + 60000), enabled: true,
  });
  const taskB = scheduledTasksDb.createTask({
    title: 'Queue check', prompt: 'p', projectPath: TMP, provider: 'claude',
    kind: 'interval', ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 300 }),
    nextRunAt: iso(NOW + 60000), enabled: true,
  });

  const run = (task, sessionId, startedAt, status = 'success') => {
    const row = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule', startedAt });
    scheduledTasksDb.finishRun(row.id, { status, finishedAt: startedAt, sessionId, output: null, error: null });
    return row;
  };

  run(taskA, SESSION_OLD, iso(NOW - 60000));
  run(taskA, SESSION_A, iso(NOW - 1000));   // newest run for SESSION_A wins
  run(taskB, SESSION_B, iso(NOW - 2000));
  scheduledTasksDb.createRun({ taskId: taskB.id, status: 'skipped', trigger: 'schedule', startedAt: iso(NOW - 500) });

  // ── index ────────────────────────────────────────────────────────────────
  await check('session_id index exists on scheduled_task_runs', async () => {
    const db = (await import(url('server/modules/database/connection.js'))).getConnection();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_task_runs'").all().map((r) => r.name);
    assert(indexes.includes('idx_scheduled_task_runs_session'), 'missing idx_scheduled_task_runs_session (have: ' + indexes.join(',') + ')');
    return indexes.join(', ');
  });

  // ── repository lookups ───────────────────────────────────────────────────
  await check('getSessionOrigins maps session -> newest task run', () => {
    const map = scheduledTasksDb.getSessionOrigins([SESSION_A, SESSION_B, 'no-such-session']);
    assert(map instanceof Map, 'expected a Map');
    assert(map.size === 2, 'expected 2 entries, got ' + map.size);
    assert(map.get(SESSION_A).taskId === taskA.id, 'wrong task for SESSION_A');
    assert(map.get(SESSION_A).taskTitle === 'Nightly review', 'wrong title: ' + map.get(SESSION_A).taskTitle);
    assert(map.get(SESSION_B).taskTitle === 'Queue check', 'wrong title for SESSION_B');
    return JSON.stringify([...map.entries()].map(([k, v]) => [k.slice(0, 8), v.taskTitle]));
  });

  await check('getSessionOrigins is empty for empty input', () => {
    assert(scheduledTasksDb.getSessionOrigins([]).size === 0, 'expected empty map');
    return 'empty';
  });

  await check('deleting a task cascades its runs, so the origin disappears', () => {
    const task = scheduledTasksDb.createTask({
      title: 'Doomed', prompt: 'p', projectPath: TMP, provider: 'claude',
      kind: 'interval', ruleJson: '{"kind":"interval","everySeconds":300}',
      nextRunAt: iso(NOW + 60000), enabled: true,
    });
    run(task, SESSION_DOOMED, iso(NOW - 30000));
    assert(scheduledTasksDb.getSessionOrigins([SESSION_DOOMED]).size === 1, 'origin should exist before the delete');
    scheduledTasksDb.deleteTask(task.id); // FK ON DELETE CASCADE
    const map = scheduledTasksDb.getSessionOrigins([SESSION_DOOMED]);
    assert(map.size === 0, 'deleted task should leave no origin, got ' + map.size);
    return 'cascade removes the origin';
  });

  await check('getAllScheduledTaskSessionIds returns every recorded session', () => {
    const set = scheduledTasksDb.getAllScheduledTaskSessionIds();
    assert(set instanceof Set, 'expected a Set');
    assert(set.has(SESSION_A) && set.has(SESSION_B), 'missing session ids: ' + JSON.stringify([...set]));
    assert(!set.has('no-such-session'), 'unexpected id');
    return set.size + ' ids';
  });

  // ── decoration + filter ──────────────────────────────────────────────────
  const makeSessions = () => [{ id: SESSION_A, title: 'a' }, { id: SESSION_B, title: 'b' }, { id: 'plain-session', title: 'c' }];

  await check('applyScheduledTaskOrigin decorates only the matching sessions', () => {
    const sessions = makeSessions();
    applyScheduledTaskOrigin(sessions, 'claude');
    assert(sessions[0].scheduledTaskOrigin?.taskId === taskA.id, 'SESSION_A not decorated');
    assert(sessions[1].scheduledTaskOrigin?.taskTitle === 'Queue check', 'SESSION_B not decorated');
    assert(sessions[2].scheduledTaskOrigin === undefined, 'plain session was decorated');
    return 'decorated 2/3';
  });

  await check('filterHiddenScheduledTaskSessions hides them by default', () => {
    const sessions = makeSessions();
    applyScheduledTaskOrigin(sessions, 'claude');
    filterHiddenScheduledTaskSessions(sessions);
    assert(sessions.length === 1 && sessions[0].id === 'plain-session', 'expected only the plain session, got ' + JSON.stringify(sessions.map((s) => s.id)));
    return 'hidden by default';
  });

  await check("setting 'scheduled_task_hide_sessions' = 'false' keeps them visible", () => {
    appConfigDb.set('scheduled_task_hide_sessions', 'false');
    try {
      const sessions = makeSessions();
      applyScheduledTaskOrigin(sessions, 'claude');
      filterHiddenScheduledTaskSessions(sessions);
      assert(sessions.length === 3, 'expected all 3 sessions, got ' + sessions.length);
      return 'visible when disabled';
    } finally {
      appConfigDb.set('scheduled_task_hide_sessions', 'true');
    }
  });

  await check('a session with no origin is never filtered', () => {
    const sessions = [{ id: 'plain-session' }];
    filterHiddenScheduledTaskSessions(sessions);
    assert(sessions.length === 1, 'plain session was removed');
    return 'kept';
  });

  // ── exclusion set used by getProjects / search ───────────────────────────
  await check('buildExcludedSessionIds includes them while hiding is on', () => {
    appConfigDb.set('scheduled_task_hide_sessions', 'true');
    const excluded = buildExcludedSessionIds('claude');
    assert(excluded instanceof Set, 'expected a Set');
    assert(excluded.has(SESSION_A) && excluded.has(SESSION_B), 'scheduled sessions not excluded: ' + JSON.stringify([...excluded]));
    return excluded.size + ' excluded';
  });

  await check('buildExcludedSessionIds drops them when hiding is off', () => {
    appConfigDb.set('scheduled_task_hide_sessions', 'false');
    try {
      const excluded = buildExcludedSessionIds('claude');
      assert(!excluded.has(SESSION_A) && !excluded.has(SESSION_B), 'still excluded with hiding off');
      return 'not excluded';
    } finally {
      appConfigDb.set('scheduled_task_hide_sessions', 'true');
    }
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
  })
  .finally(() => {
    console.log('\n[origin-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[origin-e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
