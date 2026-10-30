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
 * @param {object} [overrides] test seams: repo, validateRule, normalizeRule, computeNextRun, runNow
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
        rule: body.rule,
      });
      if (!result.ok) return sendError(res, result);
      res.status(201).json({ task: result.task });
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
        enabled: body.enabled,
        rule: body.rule,
      });
      if (!result.ok) return sendError(res, result);
      res.json({ task: result.task });
    })
  );

  // DELETE /:id
  router.delete(
    '/:id',
    handler(async (req, res) => {
      const result = await (await getManagement()).deleteTask(req.params.id);
      if (!result.ok) return sendError(res, result);
      res.json({ id: result.id, deleted: true });
    })
  );

  // POST /:id/run — start a run immediately (202 with the 'running' run row)
  router.post(
    '/:id/run',
    handler(async (req, res) => {
      const result = await (await getManagement()).runTaskNow(req.params.id);
      if (!result.ok) return sendError(res, result);
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
