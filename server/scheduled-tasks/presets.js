/**
 * Scheduled-task presets — installable bundles of scheduled-task templates.
 *
 * Contract: docs/scheduled-tasks.md §10.1–§10.3.
 *
 * The built-in catalog is version-controlled at
 * `server/scheduled-tasks/presets/builtin/<id>.json` and is authoritative for
 * name/description/icon/version/templates: every read re-seeds the catalog rows
 * while keeping the user-owned `enabled` flag. A preset is *installed* into a
 * project by materializing one real `scheduled_tasks` row per template, linked
 * back through `preset_id` + `preset_task_id`.
 *
 * Every public method returns one of:
 *   { ok: true, ...payload }
 *   { ok: false, code, message, httpStatus }
 * Unexpected errors (e.g. a broken repository) propagate; the REST route and the
 * agent tools map them to 500 / internal_error.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProjectPath } from '../shared/utils.js';
// taskRowToJson is the single source of truth for the task view; management.js
// only imports this module lazily (inside getPresets()), so this is a one-way
// static dependency, not a cycle.
import { taskRowToJson } from './management.js';
// §12: the pure parameter layer (definition validation + install overrides).
import { applyParamOverrides, normalizeParamDefs, parseParamDefs } from './params.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute directory of the shipped catalog.
 *
 * SCHEDULED_TASK_PRESET_DIR overrides it (issue #4: "or make it configurable").
 * Unset/empty keeps the shipped default; a path that does not exist degrades
 * exactly like a missing catalog directory always did — readdirSync throws, is
 * caught and the catalog seeds nothing.
 */
export const BUILTIN_PRESET_DIR = process.env.SCHEDULED_TASK_PRESET_DIR?.trim()
  ? path.resolve(process.env.SCHEDULED_TASK_PRESET_DIR.trim())
  : path.join(HERE, 'presets', 'builtin');

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RULE_KINDS = new Set(['once', 'interval', 'daily', 'weekly', 'cron']);
const DEFAULT_PROVIDER = 'claude';
const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

function fail(code, message, httpStatus = 400) {
  return { ok: false, code, message, httpStatus };
}

function notFound(message = 'Preset not found') {
  return fail('not_found', message, 404);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJson(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** §12.4: serialize a template ParamDef[] for params_json; empty => NULL. */
function serializeParams(params) {
  const defs = Array.isArray(params) ? params : [];
  return defs.length ? JSON.stringify(defs) : null;
}

/** §12.4: raw params_json already stored on a row. */
function paramsJsonOf(row) {
  const raw = row ? (row.params_json ?? row.paramsJson) : null;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return serializeParams(parseParamDefs(row ? (raw ?? row.params) : null));
}

/** Key-order-insensitive JSON so template comparison is stable. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function invalidCatalog(message) {
  const err = new Error(message);
  err.code = 'invalid_catalog';
  return err;
}

/**
 * Validate one catalog file (parsed JSON) against the §10.3 shape.
 * @returns {{ ok: true, preset } | { ok: false, code: 'invalid_catalog', message }}
 */
export function validateBuiltinPreset(raw, context = {}) {
  const label = context.file ? ` (${context.file})` : '';
  const invalid = (message) => ({
    ok: false,
    code: 'invalid_catalog',
    message: `Invalid preset catalog${label}: ${message}`,
  });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('expected a JSON object');
  const id = nonEmptyString(raw.id);
  if (!id || !KEBAB_ID.test(id)) return invalid('id must be a lower-kebab-case string');
  const name = nonEmptyString(raw.name);
  if (!name) return invalid('name is required');
  for (const field of ['description', 'icon', 'version']) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      return invalid(`${field} must be a string`);
    }
  }
  if (!Array.isArray(raw.tasks)) return invalid('tasks must be an array');
  if (!raw.tasks.length) return invalid('tasks must contain at least one template');

  const seen = new Set();
  const tasks = [];
  for (let index = 0; index < raw.tasks.length; index += 1) {
    const task = raw.tasks[index];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      return invalid(`tasks[${index}] must be an object`);
    }
    const taskId = nonEmptyString(task.id);
    if (!taskId || !KEBAB_ID.test(taskId)) {
      return invalid(`tasks[${index}].id must be a lower-kebab-case string`);
    }
    if (seen.has(taskId)) return invalid(`duplicate task id "${taskId}"`);
    seen.add(taskId);
    const title = nonEmptyString(task.title);
    if (!title) return invalid(`tasks[${index}].title is required`);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) {
      return invalid(`tasks[${index}].prompt is required`);
    }
    if (!task.rule || typeof task.rule !== 'object' || Array.isArray(task.rule) || !RULE_KINDS.has(task.rule.kind)) {
      return invalid(`tasks[${index}].rule must be an object with a known kind`);
    }
    if (task.command !== undefined && task.command !== null && nonEmptyString(task.command) === null) {
      return invalid(`tasks[${index}].command must be a non-empty string`);
    }
    if (
      task.commandTimeoutSeconds !== undefined &&
      task.commandTimeoutSeconds !== null &&
      (!Number.isInteger(task.commandTimeoutSeconds) ||
        task.commandTimeoutSeconds < 1 ||
        task.commandTimeoutSeconds > MAX_COMMAND_TIMEOUT_SECONDS)
    ) {
      return invalid(`tasks[${index}].commandTimeoutSeconds must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_SECONDS}`);
    }
    // §12.1: optional ParamDef[] on a template.
    let params = [];
    if (task.params !== undefined && task.params !== null) {
      const checkedParams = normalizeParamDefs(task.params);
      if (!checkedParams.ok) return invalid(`tasks[${index}].params: ${checkedParams.message}`);
      params = checkedParams.params;
    }
    tasks.push({
      id: taskId,
      title,
      description: nonEmptyString(task.description),
      prompt: task.prompt,
      provider: nonEmptyString(task.provider) || DEFAULT_PROVIDER,
      model: nonEmptyString(task.model),
      rule: task.rule,
      command: nonEmptyString(task.command),
      commandTimeoutSeconds: task.commandTimeoutSeconds ?? null,
      params,
    });
  }

  return {
    ok: true,
    preset: {
      id,
      name,
      description: nonEmptyString(raw.description),
      icon: nonEmptyString(raw.icon),
      version: nonEmptyString(raw.version),
      tasks,
    },
  };
}

/**
 * Load and validate the shipped catalog.
 * @returns {Array} presets sorted by id
 * @throws {Error & { code: 'invalid_catalog' }} on malformed JSON or shape
 */
export function loadBuiltinCatalog() {
  let files;
  try {
    files = fs.readdirSync(BUILTIN_PRESET_DIR);
  } catch {
    return [];
  }

  const catalog = [];
  const owners = new Map();
  for (const file of files.filter((entry) => entry.endsWith('.json')).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(BUILTIN_PRESET_DIR, file), 'utf8'));
    } catch (err) {
      throw invalidCatalog(`Invalid preset catalog (${file}): ${errorMessage(err)}`);
    }
    const checked = validateBuiltinPreset(parsed, { file });
    if (!checked.ok) throw invalidCatalog(checked.message);
    const preset = checked.preset;
    if (preset.id !== file.slice(0, -'.json'.length)) {
      throw invalidCatalog(`Invalid preset catalog (${file}): id "${preset.id}" must match the file name`);
    }
    // Template ids are the stable primary keys of scheduled_task_preset_tasks,
    // so they must be unique across the whole catalog (re-seeding must never
    // orphan the tasks installed from an earlier catalog version).
    for (const task of preset.tasks) {
      const owner = owners.get(task.id);
      if (owner && owner !== preset.id) {
        throw invalidCatalog(`Invalid preset catalog (${file}): task id "${task.id}" is already used by preset "${owner}"`);
      }
      owners.set(task.id, preset.id);
    }
    catalog.push(preset);
  }
  catalog.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return catalog;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.repo] scheduledTasksDb-compatible repository
 * @param {object} [deps.rules] { validateRule, normalizeRule, computeNextRun }
 * @param {Array} [deps.catalog] pre-loaded catalog (tests)
 * @param {object|null} [deps.workspace] workspace module (null disables it)
 * @param {object} [deps.logger]
 * @param {Function} [deps.now] () => epoch ms
 */
export function createPresetService(deps = {}) {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  let repoRef = deps.repo ?? null;
  let rulesRef = deps.rules ?? null;
  let catalogRef = Array.isArray(deps.catalog) ? deps.catalog : null;
  // undefined => resolve ./workspace.js lazily; null/false => disabled.
  let workspaceRef = deps.workspace === undefined ? undefined : deps.workspace;

  async function getRepo() {
    if (!repoRef) {
      const db = await import('../modules/database/index.js');
      repoRef = db.scheduledTasksDb;
    }
    return repoRef;
  }

  async function getRules() {
    if (!rulesRef) rulesRef = await import('./rules.js');
    return rulesRef;
  }

  async function getCatalog() {
    if (!catalogRef) catalogRef = loadBuiltinCatalog();
    return catalogRef;
  }

  async function getWorkspace() {
    if (workspaceRef === undefined) {
      try {
        workspaceRef = await import('./workspace.js');
      } catch {
        workspaceRef = null;
      }
    }
    return workspaceRef || null;
  }

  function normalizePath(value) {
    if (!value) return value;
    try {
      return normalizeProjectPath(value);
    } catch {
      return value;
    }
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    const left = normalizePath(a);
    const right = normalizePath(b);
    if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
    return left === right;
  }

  function rowProjectPath(row) {
    return row.project_path ?? row.projectPath ?? null;
  }

  function isVisible(row, projectPath) {
    if (!row) return false;
    if (row.source === 'builtin') return true;
    // No project filter => every row (same convention as repository.listPresets).
    if (projectPath === undefined || projectPath === null || projectPath === '') return true;
    return samePath(rowProjectPath(row), projectPath);
  }

  function presetTaskJson(row, presetId) {
    return {
      id: row.id,
      presetId: row.preset_id ?? row.presetId ?? presetId,
      title: row.title,
      description: row.description ?? null,
      prompt: row.prompt,
      provider: row.provider ?? DEFAULT_PROVIDER,
      model: row.model ?? null,
      kind: row.kind,
      rule: parseJson(row.rule_json ?? row.ruleJson),
      command: row.command ?? null,
      commandTimeoutSeconds: row.command_timeout_seconds ?? null,
      // §12.4: NULL/legacy JSON reads as [].
      params: parseParamDefs(row.params_json ?? row.paramsJson),
      position: row.position ?? 0,
    };
  }

  async function presetJson(row) {
    const repo = await getRepo();
    const tasks = typeof repo.listPresetTasks === 'function' ? repo.listPresetTasks(row.id) || [] : [];
    const linked = typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(row.id) || [] : [];
    const installedProjects = [];
    for (const task of linked) {
      const value = rowProjectPath(task);
      if (!value) continue;
      const normalized = normalizePath(value);
      if (!installedProjects.includes(normalized)) installedProjects.push(normalized);
    }
    return {
      id: row.id,
      source: row.source,
      name: row.name,
      description: row.description ?? null,
      icon: row.icon ?? null,
      version: row.version ?? null,
      enabled: !!row.enabled,
      projectPath: rowProjectPath(row),
      taskCount: tasks.length,
      installedProjects,
      tasks: tasks.map((task) => presetTaskJson(task, row.id)),
      createdAt: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
    };
  }

  function templateInputs(preset) {
    return preset.tasks.map((task, index) => ({
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      prompt: task.prompt,
      provider: task.provider ?? DEFAULT_PROVIDER,
      model: task.model ?? null,
      kind: task.rule.kind,
      rule: task.rule,
      command: task.command ?? null,
      commandTimeoutSeconds: task.commandTimeoutSeconds ?? null,
      paramsJson: serializeParams(task.params),
      position: index,
    }));
  }

  function templatesMatch(rows, preset) {
    if (!Array.isArray(rows) || rows.length !== preset.tasks.length) return false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const task = preset.tasks[index];
      if (String(row.id ?? '') !== String(task.id ?? '')) return false;
      if ((row.title ?? null) !== (task.title ?? null)) return false;
      if ((row.prompt ?? null) !== (task.prompt ?? null)) return false;
      if ((row.provider ?? DEFAULT_PROVIDER) !== (task.provider ?? DEFAULT_PROVIDER)) return false;
      if ((row.model ?? null) !== (task.model ?? null)) return false;
      if ((row.kind ?? null) !== (task.rule.kind ?? null)) return false;
      if ((row.command ?? null) !== (task.command ?? null)) return false;
      if ((row.command_timeout_seconds ?? null) !== (task.commandTimeoutSeconds ?? null)) return false;
      if (stableStringify(parseParamDefs(row.params_json ?? row.paramsJson)) !== stableStringify(task.params ?? [])) {
        return false;
      }
      if (stableStringify(parseJson(row.rule_json ?? row.ruleJson)) !== stableStringify(task.rule)) return false;
    }
    return true;
  }

  /** §10.1: builtin rows are owned by the catalog; enabled is the user's. */
  async function seedBuiltinCatalog() {
    const repo = await getRepo();
    if (typeof repo.createPreset !== 'function' || typeof repo.replacePresetTasks !== 'function') return;
    const catalog = await getCatalog();
    for (const preset of catalog) {
      const existing = typeof repo.getPreset === 'function' ? repo.getPreset(preset.id) : undefined;
      if (!existing) {
        repo.createPreset({
          id: preset.id,
          source: 'builtin',
          name: preset.name,
          description: preset.description,
          icon: preset.icon,
          version: preset.version,
          enabled: false,
          projectPath: null,
        });
        repo.replacePresetTasks(preset.id, templateInputs(preset));
        continue;
      }
      const patch = {};
      if ((existing.name ?? null) !== (preset.name ?? null)) patch.name = preset.name;
      if ((existing.description ?? null) !== (preset.description ?? null)) patch.description = preset.description;
      if ((existing.icon ?? null) !== (preset.icon ?? null)) patch.icon = preset.icon;
      if ((existing.version ?? null) !== (preset.version ?? null)) patch.version = preset.version;
      if (Object.keys(patch).length) repo.updatePreset(preset.id, patch);
      const current = typeof repo.listPresetTasks === 'function' ? repo.listPresetTasks(preset.id) || [] : [];
      if (!templatesMatch(current, preset)) repo.replacePresetTasks(preset.id, templateInputs(preset));
    }
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.code === 'invalid_catalog') {
        return fail('invalid_catalog', errorMessage(err), 500);
      }
      throw err;
    }
  }

  async function applyWorkspace(workspace, taskRow) {
    if (!workspace || typeof workspace.ensureTaskWorkspace !== 'function' || !taskRow) return;
    try {
      const result = workspace.ensureTaskWorkspace(taskRow);
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] preset workspace setup failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Interval rules get a fresh anchor at install/enable time (docs §1, §10.3):
   * the stored anchor is replaced so a portable preset starts its clock when it
   * is installed/reenabled in the target project.
   */
  function prepareRule(rawRule, rules, fromMs) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) return null;
    let candidate = rawRule;
    if (candidate.kind === 'interval') {
      candidate = { ...candidate, anchorMs: fromMs };
    }
    const checked = rules.validateRule(candidate);
    if (!checked || !checked.ok) return null;
    try {
      return rules.normalizeRule(checked.rule ?? candidate);
    } catch {
      return null;
    }
  }

  function computeNextIso(rule, rules, fromMs) {
    try {
      return toIso(rules.computeNextRun(rule, fromMs));
    } catch {
      return null;
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  async function listPresets(options = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const projectPath = options.projectPath;
      const rows = repo.listPresets(projectPath === undefined ? undefined : { projectPath }) || [];
      const presets = [];
      for (const row of rows) presets.push(await presetJson(row));
      return { ok: true, presets };
    });
  }

  async function getPreset(id, options = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const row = repo.getPreset(id);
      if (!row || !isVisible(row, options.projectPath)) return notFound();
      return { ok: true, preset: await presetJson(row) };
    });
  }

  // ─── Install / enable ───────────────────────────────────────────────────────

  async function installPreset(id, options = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const projectPath = nonEmptyString(options.projectPath);
      if (!projectPath) return fail('invalid_input', 'projectPath is required');
      // §10.1: install is deliberately unscoped — a preset is a portable package
      // and may be materialized into any target project, even when its own
      // project_path differs. Scope matching only gates discovery/mutation.
      const row = repo.getPreset(id);
      if (!row) return notFound();

      // §12.5: install-time parameter overrides, applied to every installed task
      // whose template declares that name (other names are ignored).
      const overrides = options.params;
      if (
        overrides !== undefined &&
        overrides !== null &&
        (typeof overrides !== 'object' || Array.isArray(overrides))
      ) {
        return fail('invalid_input', 'params must be an object');
      }

      const rules = await getRules();
      const workspace = await getWorkspace();
      const templates = typeof repo.listPresetTasks === 'function' ? repo.listPresetTasks(id) || [] : [];
      const linked = typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(id) || [] : [];
      // §10.1/§10.3: install enables the bundle by default; only an explicit
      // enabled:false installs it paused. The effective value is recorded on the
      // preset so the whole-bundle switch starts from the right state.
      const effective = typeof options.enabled === 'boolean' ? options.enabled : true;
      const nowMs = now();
      const created = [];
      const updated = [];
      const skipped = [];

      // §12.5/N2: resolve every template's install overrides *before* creating or
      // updating anything, so a rejected override materializes nothing instead of
      // leaving a partially installed preset behind.
      const templateParamsById = new Map();
      for (const template of templates) {
        const templateDefs = parseParamDefs(template.params_json ?? template.paramsJson);
        let templateParams = templateDefs;
        if (overrides !== undefined && overrides !== null) {
          const applied = applyParamOverrides(templateDefs, overrides);
          if (!applied.ok) return fail(applied.code, applied.message);
          templateParams = applied.params;
        }
        templateParamsById.set(template.id, templateParams);
      }

      for (const template of templates) {
        const rule = prepareRule(parseJson(template.rule_json ?? template.ruleJson), rules, nowMs);
        const nextIso = rule ? computeNextIso(rule, rules, nowMs) : null;
        // §10.3(6): a template with no upcoming run is skipped, never fatal.
        if (!rule || !nextIso) {
          skipped.push(template.id);
          continue;
        }
        const existing = linked.find(
          (task) =>
            (task.preset_task_id ?? task.presetTaskId ?? null) === template.id &&
            samePath(rowProjectPath(task), projectPath)
        );
        const templateParams =
          templateParamsById.get(template.id) ??
          parseParamDefs(template.params_json ?? template.paramsJson);
        const patch = {
          title: template.title,
          prompt: template.prompt,
          projectPath,
          provider: template.provider ?? DEFAULT_PROVIDER,
          model: template.model ?? null,
          kind: rule.kind,
          ruleJson: JSON.stringify(rule),
          command: template.command ?? null,
          commandTimeoutSeconds: template.command_timeout_seconds ?? null,
          paramsJson: serializeParams(templateParams),
          enabled: effective,
          nextRunAt: effective ? nextIso : null,
        };
        const target = existing
          ? repo.updateTask(existing.id, patch)
          : repo.createTask({
              ...patch,
              userId: options.userId ?? null,
              presetId: id,
              presetTaskId: template.id,
            });
        if (existing && target) updated.push(existing.id);
        else if (target) created.push(target.id);
        await applyWorkspace(workspace, target);
      }

      repo.updatePreset(id, {
        enabled: effective,
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      });
      const fresh = repo.getPreset(id) ?? row;
      const tasks = (typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(id) || [] : [])
        .filter((task) => samePath(rowProjectPath(task), projectPath))
        .map(taskRowToJson);
      return { ok: true, preset: await presetJson(fresh), tasks, created, updated, skipped };
    });
  }

  async function setPresetEnabled(id, enabled, options = {}) {
    return guarded(async () => {
      if (typeof enabled !== 'boolean') return fail('invalid_input', 'enabled must be a boolean');
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const row = repo.getPreset(id);
      if (!row || !isVisible(row, options.projectPath)) return notFound();

      const rules = await getRules();
      const workspace = await getWorkspace();
      const updatedRow = repo.updatePreset(id, { enabled }) ?? row;
      const nowMs = now();
      const linked = typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(id) || [] : [];
      const scoped = options.projectPath
        ? linked.filter((task) => samePath(rowProjectPath(task), options.projectPath))
        : linked;

      for (const task of scoped) {
        const patch = { enabled };
        if (enabled) {
          const rule = prepareRule(parseJson(task.rule_json ?? task.ruleJson), rules, nowMs);
          patch.nextRunAt = rule ? computeNextIso(rule, rules, nowMs) : null;
        } else {
          patch.nextRunAt = null;
        }
        const target = repo.updateTask(task.id, patch);
        await applyWorkspace(workspace, target ?? task);
      }

      const tasks = (typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(id) || [] : [])
        .filter((task) => !options.projectPath || samePath(rowProjectPath(task), options.projectPath))
        .map(taskRowToJson);
      return { ok: true, preset: await presetJson(updatedRow), tasks };
    });
  }

  // ─── Custom presets ─────────────────────────────────────────────────────────

  async function createCustomPreset(input = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      const name = nonEmptyString(input.name);
      const projectPath = nonEmptyString(input.projectPath);
      if (!name) return fail('invalid_input', 'name is required');
      if (!projectPath) return fail('invalid_input', 'projectPath is required');
      const taskIds = Array.isArray(input.taskIds)
        ? input.taskIds
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.trim())
        : [];
      if (!taskIds.length) return fail('no_tasks', 'At least one task id is required');

      const sources = [];
      for (const taskId of taskIds) {
        const task = repo.getTask(taskId);
        if (!task || !samePath(rowProjectPath(task), projectPath)) {
          return notFound(`Scheduled task ${taskId} not found`);
        }
        sources.push(task);
      }

      const preset = repo.createPreset({
        source: 'custom',
        name,
        description: nonEmptyString(input.description),
        icon: nonEmptyString(input.icon),
        version: nonEmptyString(input.version),
        enabled: false,
        projectPath,
        userId: input.userId ?? null,
      });
      repo.replacePresetTasks(
        preset.id,
        sources.map((task, index) => ({
          id: crypto.randomUUID(),
          title: task.title,
          description: null,
          prompt: task.prompt,
          provider: task.provider ?? DEFAULT_PROVIDER,
          model: task.model ?? null,
          kind: task.kind,
          rule: parseJson(task.rule_json ?? task.ruleJson),
          command: task.command ?? null,
          commandTimeoutSeconds: task.command_timeout_seconds ?? null,
          paramsJson: paramsJsonOf(task),
          position: index,
        }))
      );
      return { ok: true, preset: await presetJson(repo.getPreset(preset.id) ?? preset) };
    });
  }

  async function updatePreset(id, patch = {}, options = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const row = repo.getPreset(id);
      if (!row || !isVisible(row, options.projectPath)) return notFound();
      if (row.source !== 'custom') {
        return fail('builtin_preset', 'Built-in presets cannot be edited', 400);
      }

      const changes = {};
      if (patch.name !== undefined) {
        const name = nonEmptyString(patch.name);
        if (!name) return fail('invalid_input', 'name must be a non-empty string');
        changes.name = name;
      }
      for (const field of ['description', 'icon']) {
        if (patch[field] === undefined) continue;
        if (patch[field] === null) {
          changes[field] = null;
          continue;
        }
        if (typeof patch[field] !== 'string') {
          return fail('invalid_input', `${field} must be a string or null`);
        }
        changes[field] = patch[field].trim() || null;
      }
      if (!Object.keys(changes).length) {
        return fail('invalid_input', 'Nothing to update: name, description or icon');
      }

      const updated = repo.updatePreset(id, changes);
      if (!updated) return notFound();
      return { ok: true, preset: await presetJson(updated) };
    });
  }

  async function deletePreset(id, options = {}, scope = {}) {
    return guarded(async () => {
      const repo = await getRepo();
      await seedBuiltinCatalog();
      const row = repo.getPreset(id);
      if (!row || !isVisible(row, scope.projectPath)) return notFound();

      const projectPath = scope.projectPath;
      const linked = (typeof repo.listTasksByPreset === 'function' ? repo.listTasksByPreset(id) || [] : []).filter(
        (task) => !projectPath || samePath(rowProjectPath(task), projectPath)
      );
      // Builtin "delete" is an uninstall: the installed tasks always go away,
      // the catalog row/templates stay. Custom presets only purge tasks when
      // asked (REST default purge=1, agent tools never purge).
      const purge = row.source === 'builtin' ? true : options.purge !== false;
      let removedTasks = 0;
      if (purge) {
        for (const task of linked) {
          if (repo.deleteTask(task.id)) removedTasks += 1;
        }
      }
      if (row.source === 'custom') repo.deletePreset(id);
      else repo.updatePreset(id, { enabled: false });

      return { ok: true, id, deleted: true, source: row.source, removedTasks };
    });
  }

  return {
    listPresets,
    getPreset,
    installPreset,
    setPresetEnabled,
    createCustomPreset,
    updatePreset,
    deletePreset,
  };
}
