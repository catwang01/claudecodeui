/**
 * Scheduled tasks REST API — mounted at /api/scheduled-tasks (authenticated).
 *
 * Contract: docs/scheduled-tasks.md §5 REST table. All orchestration and view
 * serialization lives in ../scheduled-tasks/management.js; this module only
 * translates HTTP <-> management results.
 *
 * The router is created by a factory so tests can inject the repository and the
 * rules engine; the default export resolves them lazily from the real modules.
 */

import express from 'express';
import { createManagement } from '../scheduled-tasks/management.js';

let cachedDefaults = null;

async function loadDefaults() {
  if (!cachedDefaults) {
    const [rules, db, service] = await Promise.all([
      import('../scheduled-tasks/rules.js'),
      import('../modules/database/index.js'),
      import('../scheduled-tasks/service.js'),
    ]);
    cachedDefaults = {
      validateRule: rules.validateRule,
      normalizeRule: rules.normalizeRule,
      computeNextRun: rules.computeNextRun,
      repo: db.scheduledTasksDb,
      runNow: service.runScheduledTaskNow,
    };
  }
  return cachedDefaults;
}

/**
 * @param {object} [overrides] test seams: repo, validateRule, normalizeRule,
 *   computeNextRun, runNow, presets, workspace, catalog
 * @returns {import('express').Router}
 */
export function createScheduledTasksRouter(overrides = {}) {
  const router = express.Router();
  const resolved = { ...overrides };
  let management = null;

  async function dep(name) {
    if (resolved[name] !== undefined) return resolved[name];
    const defaults = await loadDefaults();
    if (defaults[name] !== undefined) resolved[name] = defaults[name];
    return defaults[name];
  }

  async function getManagement() {
    if (management) return management;
    const [repo, validateRule, normalizeRule, computeNextRun, runNow] = await Promise.all([
      dep('repo'),
      dep('validateRule'),
      dep('normalizeRule'),
      dep('computeNextRun'),
      dep('runNow'),
    ]);
    management = createManagement({
      repo,
      runNow,
      rules: { validateRule, normalizeRule, computeNextRun },
      presets: overrides.presets,
      workspace: overrides.workspace,
      catalog: overrides.catalog,
    });
    return management;
  }

  function handler(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        // Never leak stack traces to the client.
        console.error('[scheduled-tasks] request failed:', err && err.message ? err.message : err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
        }
      }
    };
  }

  function sendError(res, result) {
    return res
      .status(result.httpStatus || 400)
      .json({ error: result.message, code: result.code });
  }

  // GET / — list tasks (?status=active|paused|all&search=)
  router.get(
    '/',
    handler(async (req, res) => {
      const result = await (await getManagement()).listTasks({
        userId: req.user?.id ?? null,
        status: req.query.status,
        search: req.query.search,
        tag: req.query.tag,
      });
      res.json({ tasks: result.tasks });
    })
  );

  // POST / — create a task
  router.post(
    '/',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).createTask({
        userId: req.user?.id ?? null,
        title: body.title,
        prompt: body.prompt,
        projectPath: body.projectPath,
        provider: body.provider,
        model: body.model,
        command: body.command,
        commandTimeoutSeconds: body.commandTimeoutSeconds,
        params: body.params,
        conflictPolicy: body.conflictPolicy,
        tags: body.tags,
        rule: body.rule,
      });
      if (!result.ok) return sendError(res, result);
      res.status(201).json({ task: result.task });
    })
  );

  // POST /import — create a paused task from an exported envelope (docs §16).
  // Declared before /:id: the literal "import" must never be read as a task id.
  router.post(
    '/import',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).importTask({
        ...body,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) return sendError(res, result);
      res.status(201).json({ task: result.task });
    })
  );

  // ─── Presets (§10.5) ─────────────────────────────────────────────────────────
  // Registered BEFORE /:id: otherwise GET /presets would be captured by GET /:id.

  function presetScope(req) {
    const body = req.body || {};
    if (body.projectPath !== undefined) return body.projectPath;
    return req.query?.projectPath;
  }

  function truthyQuery(value, fallback = false) {
    if (value === undefined) return fallback;
    const normalized = String(value).toLowerCase();
    return normalized !== '0' && normalized !== 'false' && normalized !== '';
  }

  // GET /presets — list builtin + in-project custom presets (?projectPath=)
  router.get(
    '/presets',
    handler(async (req, res) => {
      const result = await (await getManagement()).presets.listPresets({
        projectPath: req.query?.projectPath,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ presets: result.presets });
    })
  );

  // POST /presets — snapshot existing tasks of a project into a custom preset
  router.post(
    '/presets',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).presets.createCustomPreset({
        name: body.name,
        description: body.description,
        projectPath: body.projectPath,
        taskIds: body.taskIds,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) return sendError(res, result);
      res.status(201).json({ preset: result.preset });
    })
  );

  // GET /presets/:id
  router.get(
    '/presets/:id',
    handler(async (req, res) => {
      const result = await (await getManagement()).presets.getPreset(req.params.id, {
        projectPath: req.query?.projectPath,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ preset: result.preset });
    })
  );

  // PATCH /presets/:id — custom presets only
  router.patch(
    '/presets/:id',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).presets.updatePreset(
        req.params.id,
        { name: body.name, description: body.description, icon: body.icon },
        { projectPath: presetScope(req) }
      );
      if (!result.ok) return sendError(res, result);
      res.json({ preset: result.preset });
    })
  );

  // POST /presets/:id/install
  router.post(
    '/presets/:id/install',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).presets.installPreset(req.params.id, {
        projectPath: body.projectPath,
        enabled: body.enabled,
        params: body.params,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) return sendError(res, result);
      res.json({
        preset: result.preset,
        tasks: result.tasks,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      });
    })
  );

  // POST /presets/:id/enable | /disable — whole-preset switch
  for (const [action, enabled] of [['enable', true], ['disable', false]]) {
    router.post(
      `/presets/:id/${action}`,
      handler(async (req, res) => {
        const result = await (await getManagement()).presets.setPresetEnabled(req.params.id, enabled, {
          projectPath: presetScope(req),
        });
        if (!result.ok) return sendError(res, result);
        res.json({ preset: result.preset, tasks: result.tasks });
      })
    );
  }

  // POST /presets/:id/upgrade — re-materialize a builtin preset from the catalog,
  // keeping every installed task's enabled flag (docs §16).
  router.post(
    '/presets/:id/upgrade',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).presets.upgradePreset(req.params.id, {
        projectPath: body.projectPath,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ preset: result.preset, tasks: result.tasks, projects: result.projects });
    })
  );

  // DELETE /presets/:id — ?purge=0 keeps the installed tasks (default purge=1)
  router.delete(
    '/presets/:id',
    handler(async (req, res) => {
      const result = await (await getManagement()).presets.deletePreset(
        req.params.id,
        { purge: truthyQuery(req.query?.purge, true) },
        { projectPath: req.query?.projectPath }
      );
      if (!result.ok) return sendError(res, result);
      res.json({ id: result.id, deleted: true, removedTasks: result.removedTasks });
    })
  );

  // GET /running — how many tasks have an agent-started run in flight (docs §14.3).
  // Registered before /:id, otherwise the literal "running" is read as a task id
  // (same reason as the /presets routes above).
  router.get(
    '/running',
    handler(async (req, res) => {
      const result = await (await getManagement()).countRunningTasks();
      if (!result.ok) return sendError(res, result);
      res.json({ count: result.count });
    })
  );

  // GET /upcoming — the next occurrences of active tasks (?days=7&limit=200),
  // registered before /:id so the literal "upcoming" is never read as a task id.
  router.get(
    '/upcoming',
    handler(async (req, res) => {
      const result = await (await getManagement()).listUpcoming({
        userId: req.user?.id ?? null,
        days: req.query.days,
        limit: req.query.limit,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ upcoming: result.upcoming });
    })
  );

  // GET /:id/export — the portable single-task envelope (docs §16).
  router.get(
    '/:id/export',
    handler(async (req, res) => {
      const result = await (await getManagement()).exportTask(req.params.id);
      if (!result.ok) return sendError(res, result);
      res.json({
        format: result.format,
        version: result.version,
        exportedAt: result.exportedAt,
        task: result.task,
      });
    })
  );

  // POST /:id/copy — duplicate a task (paused unless enabled:true, docs §15).
  router.post(
    '/:id/copy',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).copyTask(req.params.id, {
        title: body.title,
        projectPath: body.projectPath,
        enabled: body.enabled,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) return sendError(res, result);
      res.status(201).json({ task: result.task });
    })
  );

  // POST /:id/preview — run the script gate only (docs §20); body { params }.
  router.post(
    '/:id/preview',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).previewTask(req.params.id, { params: body.params });
      if (!result.ok) return sendError(res, result);
      res.json({ preview: result.preview });
    })
  );

  // GET /:id
  router.get(
    '/:id',
    handler(async (req, res) => {
      const result = await (await getManagement()).getTask(req.params.id);
      if (!result.ok) return sendError(res, result);
      res.json({ task: result.task });
    })
  );

  // PATCH /:id
  router.patch(
    '/:id',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).updateTask(req.params.id, {
        title: body.title,
        prompt: body.prompt,
        projectPath: body.projectPath,
        model: body.model,
        command: body.command,
        commandTimeoutSeconds: body.commandTimeoutSeconds,
        params: body.params,
        conflictPolicy: body.conflictPolicy,
        tags: body.tags,
        enabled: body.enabled,
        rule: body.rule,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ task: result.task });
    })
  );

  // DELETE /:id — ?purge=1 also removes the task workspace <root>/<taskId> (§10.4)
  router.delete(
    '/:id',
    handler(async (req, res) => {
      const purge = truthyQuery(req.query?.purge, false);
      const result = await (await getManagement()).deleteTask(req.params.id, {}, { purge });
      if (!result.ok) return sendError(res, result);
      res.json({ id: result.id, deleted: true });
    })
  );

  // POST /:id/run — start a run immediately (202 with the 'running' run row).
  // The optional body { params } carries §12.3 per-run overrides. Under the §17
  // 'queue' conflict policy a run already in flight is queued instead: the reply
  // is 202 { queued: true } and no run row exists yet.
  router.post(
    '/:id/run',
    handler(async (req, res) => {
      const body = req.body || {};
      const result = await (await getManagement()).runTaskNow(req.params.id, {}, { params: body.params });
      if (!result.ok) return sendError(res, result);
      if (result.queued) return res.status(202).json({ queued: true });
      res.status(202).json({ run: result.run });
    })
  );

  // GET /:id/runs — run history (?limit=20&offset=0)
  router.get(
    '/:id/runs',
    handler(async (req, res) => {
      const result = await (await getManagement()).listRuns(req.params.id, {
        limit: req.query.limit,
        offset: req.query.offset,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ runs: result.runs, total: result.total });
    })
  );

  return router;
}

export default createScheduledTasksRouter();
