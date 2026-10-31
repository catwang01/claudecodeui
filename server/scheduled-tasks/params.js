/**
 * Parametrized scheduled tasks — the pure parameter layer.
 *
 * Contract: docs/scheduled-tasks.md §12.1 (model), §12.2 (env contract),
 * §12.3 (resolution / precedence), §12.5 (module contracts), §12.6
 * (agent-facing text) and §13 (built-in parameters).
 *
 * This module is deliberately side-effect free: no I/O, no database, no process
 * state. Everything else (management, presets, the runner, the REST routes and
 * the agent tools) imports the rules from here so they cannot drift.
 *
 *   normalizeParamDefs(input)      -> { ok: true, params } | { ok: false, code, message }
 *   resolveParams(params, overrides)-> { ok: true, values, json, env, params } | { ok: false, code, message }
 *   paramEnv(params, overrides)    -> Record<string, string> | null
 *   builtinParamsEnv(task, { cwd })-> Record<string, string>   (§13: never null)
 *   predefinedVarsPromptBlock()    -> string                   (§13: never null)
 *
 * PREDEFINED_TASK_VARS is the single source of truth for the §13 predefined
 * variables: the prompt block (predefinedVarsPromptBlock) and the MCP tool
 * descriptions (tools.js) both render from it, so they cannot drift.
 */

/** §12.2: every parameter is exported as this prefix + the upper-cased name. */
export const PARAM_ENV_PREFIX = 'SCHEDULED_TASK_PARAM_';

/** §12.2: compact JSON escape hatch holding every resolved value. */
export const PARAMS_ENV_NAME = 'SCHEDULED_TASK_PARAMS';

/** §12.1 limits. */
export const MAX_PARAM_COUNT = 32;
export const MAX_PARAM_JSON_BYTES = 16 * 1024;
export const MAX_PARAM_DESCRIPTION_LENGTH = 500;

/**
 * §12.1/§12.3: a single resolved value (default or override) may be at most this
 * many characters. Together with the aggregate JSON cap this keeps the exported
 * environment far below the OS E2BIG limit and bounds what a run may persist.
 */
export const MAX_PARAM_VALUE_LENGTH = 4096;

export const PARAM_TYPES = ['string', 'number', 'boolean'];

const DEFAULT_PARAM_TYPE = 'string';
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Reserved variables the app itself sets for every run (§12.2/§10.4/§13.1). */
export const RESERVED_SCHEDULED_TASK_ENV = [
  'SCHEDULED_TASK_ID',
  'SCHEDULED_TASK_TITLE',
  'SCHEDULED_TASK_CWD',
  'SCHEDULED_TASK_PROJECT',
  'SCHEDULED_TASK_DIR',
  'SCHEDULED_TASK_STATE_DIR',
  'SCHEDULED_TASK_TMP_DIR',
  'SCHEDULED_TASK_RUN_ID',
  'SCHEDULED_TASK_RUN_DIR',
  PARAMS_ENV_NAME,
];

/**
 * §13.1: every predefined variable a run exports, with the one-line meaning used
 * by the agent prompt block and by the MCP tool descriptions (single source of
 * truth, so those texts cannot drift).
 *
 * group      'builtin'   the built-in parameters (task/run identity)
 *            'workspace' the §10.4 workspace variables
 * agentEnv   true  => the agent session also receives it as an environment variable
 *            false => script-gate-only; the agent reads the same value as text in
 *                     the Scheduled task workspace block
 *
 * The reserved SCHEDULED_TASK_* namespace is deliberately NOT the §12.2
 * SCHEDULED_TASK_PARAM_* namespace, so a declared parameter can never replace a
 * predefined variable (§13.2, §13.3).
 */
export const PREDEFINED_TASK_VARS = [
  {
    group: 'builtin',
    name: 'TITLE',
    envName: 'SCHEDULED_TASK_TITLE',
    description: "the task's name",
    agentEnv: true,
  },
  {
    group: 'builtin',
    name: 'CWD',
    envName: 'SCHEDULED_TASK_CWD',
    description: 'the working directory of this run',
    agentEnv: true,
  },
  {
    group: 'builtin',
    name: 'PROJECT',
    envName: 'SCHEDULED_TASK_PROJECT',
    description: 'the absolute path of the project root that owns the task',
    agentEnv: true,
  },
  {
    group: 'workspace',
    name: 'ID',
    envName: 'SCHEDULED_TASK_ID',
    description: 'the id of the scheduled-task row, stable across its runs — this is NOT a chat session id',
    agentEnv: false,
  },
  {
    group: 'workspace',
    name: 'DIR',
    envName: 'SCHEDULED_TASK_DIR',
    description: 'the root of the workspace tree of this task',
    agentEnv: false,
  },
  {
    group: 'workspace',
    name: 'STATE_DIR',
    envName: 'SCHEDULED_TASK_STATE_DIR',
    description: 'durable per-task state directory (survives across runs)',
    agentEnv: false,
  },
  {
    group: 'workspace',
    name: 'TMP_DIR',
    envName: 'SCHEDULED_TASK_TMP_DIR',
    description: 'task scratch directory, wiped at the start of every run',
    agentEnv: false,
  },
  {
    group: 'workspace',
    name: 'RUN_ID',
    envName: 'SCHEDULED_TASK_RUN_ID',
    description: 'the id of this run (not the task id)',
    agentEnv: false,
  },
  {
    group: 'workspace',
    name: 'RUN_DIR',
    envName: 'SCHEDULED_TASK_RUN_DIR',
    description: 'this run directory (run.json, prompt.md, output.md, logs/)',
    agentEnv: false,
  },
];

/** §13.1: the built-in-parameter subset (the three parameters of every run). */
export const BUILTIN_PARAMS = PREDEFINED_TASK_VARS.filter((entry) => entry.group === 'builtin');

/** §13.1: every predefined env name (built-ins + workspace variables). */
export const PREDEFINED_ENV_NAMES = PREDEFINED_TASK_VARS.map((entry) => entry.envName);

/**
 * §13.3: the exact built-in names server/claude-sdk.js may merge into the
 * provider environment (the workspace variables stay script-gate-only; the agent
 * reads them as text in the workspace block). Kept here so the runner, the docs
 * and the allowlist cannot drift.
 */
export const BUILTIN_PARAM_ENV_NAMES = BUILTIN_PARAMS.map((entry) => entry.envName);

/**
 * §13.6: the one id that is NOT an environment variable, worded once so the agent
 * prompt, the MCP descriptions and the docs stay identical.
 */
export const SESSION_ID_NOTE =
  'The chat session id a run creates is NOT an environment variable and does not exist when the run starts: the provider creates it after the run begins, so it is null for a dry run or a failed start. It is recorded on the run instead — the run history in this app and runs/<runId>/run.json "sessionId" — not in the gate env.';

function fail(message, code = 'invalid_input') {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(text) {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  return new TextEncoder().encode(text).length;
}

/** §12.2: derived variable name. Derived from the *stored* name. */
export function paramEnvName(name) {
  return PARAM_ENV_PREFIX + String(name).toUpperCase();
}

/**
 * §12.2: booleans are 'true'/'false', numbers use String(value), strings pass
 * through verbatim.
 */
export function paramEnvValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Type coercion (§12.3: applies to defaults and overrides alike).
 * Accepts the natural JSON type plus the string forms a form/HTTP body carries.
 * @returns {{ ok: true, value: string|number|boolean } | { ok: false, message: string }}
 */
export function coerceParamValue(type, value) {
  const kind = PARAM_TYPES.includes(type) ? type : DEFAULT_PARAM_TYPE;
  if (kind === 'string') {
    if (typeof value === 'string') return { ok: true, value };
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) };
    if (typeof value === 'boolean') return { ok: true, value: value ? 'true' : 'false' };
    return fail('must be a string');
  }
  if (kind === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return { ok: true, value: parsed };
    }
    return fail('must be a number');
  }
  // boolean
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number' && (value === 0 || value === 1)) return { ok: true, value: value === 1 };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return { ok: true, value: true };
    if (normalized === 'false' || normalized === '0') return { ok: true, value: false };
  }
  return fail('must be a boolean');
}

/**
 * §12.1/§12.3: bound a resolved value (default or override). A value longer than
 * MAX_PARAM_VALUE_LENGTH, or containing NUL, is invalid_input — a NUL in a stored
 * default would otherwise break every later spawn of that task.
 * @returns {{ ok: true } | { ok: false, code: 'invalid_input', message: string }}
 */
export function checkParamValue(label, value) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.includes('\u0000')) {
    return fail(`${label} must not contain NUL (\\u0000)`);
  }
  if (text.length > MAX_PARAM_VALUE_LENGTH) {
    return fail(`${label} must be at most ${MAX_PARAM_VALUE_LENGTH} characters`);
  }
  return { ok: true };
}

/**
 * §12.1/§12.5: validate and canonicalize a ParamDef[].
 *   - at most 32 parameters, names unique case-insensitively
 *   - name ^[A-Za-z_][A-Za-z0-9_]{0,63}$
 *   - type is 'string' | 'number' | 'boolean' (default 'string')
 *   - description <= 500 chars
 *   - required is a boolean
 *   - a default is coerced to its type; an uncoercible default is invalid_input
 *   - JSON.stringify(params) <= 16 KiB
 * @returns {{ ok: true, params: Array<object> } | { ok: false, code: 'invalid_input', message: string }}
 */
export function normalizeParamDefs(input) {
  if (input === undefined || input === null) return { ok: true, params: [] };
  if (!Array.isArray(input)) return fail('params must be an array of parameter definitions');
  if (input.length > MAX_PARAM_COUNT) {
    return fail(`at most ${MAX_PARAM_COUNT} parameters are allowed`);
  }

  const seen = new Set();
  const params = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!isPlainObject(raw)) return fail(`params[${index}] must be an object`);
    const name = raw.name;
    if (typeof name !== 'string' || !PARAM_NAME_RE.test(name)) {
      return fail(`params[${index}].name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) return fail(`duplicate parameter name "${name}"`);
    seen.add(lower);

    let type = DEFAULT_PARAM_TYPE;
    if (raw.type !== undefined && raw.type !== null) {
      if (!PARAM_TYPES.includes(raw.type)) {
        return fail(`params[${index}].type must be one of ${PARAM_TYPES.join(', ')}`);
      }
      type = raw.type;
    }

    const def = { name, type };

    if (raw.default !== undefined && raw.default !== null) {
      const coerced = coerceParamValue(type, raw.default);
      if (!coerced.ok) {
        return fail(`params[${index}].default ${coerced.message} (parameter "${name}" is ${type})`);
      }
      const bounded = checkParamValue(`params[${index}].default`, coerced.value);
      if (!bounded.ok) return bounded;
      def.default = coerced.value;
    }

    if (raw.description !== undefined && raw.description !== null) {
      if (typeof raw.description !== 'string') {
        return fail(`params[${index}].description must be a string`);
      }
      if (raw.description.length > MAX_PARAM_DESCRIPTION_LENGTH) {
        return fail(`params[${index}].description must be at most ${MAX_PARAM_DESCRIPTION_LENGTH} characters`);
      }
      const description = raw.description.trim();
      if (description) def.description = description;
    }

    if (raw.required !== undefined && raw.required !== null) {
      if (typeof raw.required !== 'boolean') {
        return fail(`params[${index}].required must be a boolean`);
      }
      if (raw.required) def.required = true;
    }

    params.push(def);
  }

  const serialized = JSON.stringify(params);
  if (byteLength(serialized) > MAX_PARAM_JSON_BYTES) {
    return fail(`params JSON must be at most ${MAX_PARAM_JSON_BYTES} bytes`);
  }
  return { ok: true, params };
}

/**
 * Lenient reader for a stored params value: a ParamDef[] (already parsed), a
 * params_json string, or unreadable/legacy JSON. Unreadable/legacy JSON reads
 * as [] (§12.4) and never throws.
 * @returns {Array<object>}
 */
export function parseParamDefs(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    const checked = normalizeParamDefs(raw);
    return checked.ok ? checked.params : [];
  }
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    return parseParamDefs(parsed);
  }
  return [];
}

/** Validate an overrides map (name -> value). @returns {{ok:true, map} | {ok:false}} */
function normalizeOverrides(overrides) {
  // Null-prototype map: a JSON body can carry an own "__proto__" key, and plain
  // assignment would turn that into a prototype set (silently dropping it)
  // instead of leaving it for the unknown-parameter check in resolveParams.
  if (overrides === undefined || overrides === null) return { ok: true, map: Object.create(null) };
  if (!isPlainObject(overrides)) return fail('params overrides must be an object');
  const map = Object.create(null);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    map[key] = value;
  }
  return { ok: true, map };
}

/**
 * §12.3 resolution, low → high precedence: ParamDef.default, then the per-run
 * override. Returns the typed value map, its compact JSON and the env export.
 * @returns {{ ok: true, params: Array<object>, values: object, json: string|null, env: object|null }
 *          | { ok: false, code: 'invalid_input'|'missing_required_param', message: string }}
 */
export function resolveParams(params, overrides) {
  const checkedDefs = normalizeParamDefs(params);
  if (!checkedDefs.ok) return checkedDefs;
  const defs = checkedDefs.params;

  const checkedOverrides = normalizeOverrides(overrides);
  if (!checkedOverrides.ok) return checkedOverrides;
  const overrideMap = checkedOverrides.map;

  const byLower = new Map(defs.map((def) => [def.name.toLowerCase(), def]));
  for (const key of Object.keys(overrideMap)) {
    if (!byLower.has(key.toLowerCase())) {
      return fail(`Unknown parameter "${key}"`);
    }
  }

  const values = {};
  for (const def of defs) {
    const overrideKey = Object.keys(overrideMap).find((key) => key.toLowerCase() === def.name.toLowerCase());
    let source;
    if (overrideKey !== undefined) source = overrideMap[overrideKey];
    else if (def.default !== undefined) source = def.default;

    if (source === undefined) {
      if (def.required) {
        return {
          ok: false,
          code: 'missing_required_param',
          message: `Missing required parameter "${def.name}"`,
        };
      }
      continue;
    }

    const coerced = coerceParamValue(def.type, source);
    if (!coerced.ok) {
      return fail(`Parameter "${def.name}" ${coerced.message}`);
    }
    // §12.3: defaults and overrides share the same value bounds.
    const bounded = checkParamValue(`Parameter "${def.name}"`, coerced.value);
    if (!bounded.ok) return bounded;
    // Own property, not a prototype set: a parameter literally named "__proto__"
    // must land in values/JSON/env like any other name and never be dropped.
    Object.defineProperty(values, def.name, {
      value: coerced.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const json = defs.length ? JSON.stringify(values) : null;
  // §12.3: the compact resolved JSON is bounded too, so 32 near-limit values can
  // never produce a multi-megabyte env var / run row / run.json.
  if (json !== null && byteLength(json) > MAX_PARAM_JSON_BYTES) {
    return fail(`Resolved params JSON must be at most ${MAX_PARAM_JSON_BYTES} bytes`);
  }
  const env = defs.length ? paramEnvFromValues(defs, values) : null;
  return { ok: true, params: defs, values, json, env };
}

/** §12.2 env contract for an already-resolved value map. */
export function paramEnvFromValues(params, values) {
  if (!Array.isArray(params) || params.length === 0) return null;
  const source = isPlainObject(values) ? values : {};
  const env = {};
  for (const def of params) {
    if (!def || typeof def !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(source, def.name)) continue;
    env[paramEnvName(def.name)] = paramEnvValue(source[def.name]);
  }
  env[PARAMS_ENV_NAME] = JSON.stringify(source);
  return env;
}

/**
 * §13.1/§13.3: the built-in variables for one run. Values
 * come from the task and the run, never from a caller, so neither a declared
 * parameter nor a per-run override can change them.
 * @param {{title?: string, project_path?: string, projectPath?: string}} task
 * @param {{cwd?: string}} [options] the directory this run executes in
 * @returns {Record<string, string>} always the three §13.1 variables
 */
export function builtinParamsEnv(task, { cwd } = {}) {
  const source = isPlainObject(task) ? task : {};
  const title = typeof source.title === 'string' ? source.title : '';
  const projectPath =
    typeof source.project_path === 'string'
      ? source.project_path
      : typeof source.projectPath === 'string'
        ? source.projectPath
        : '';
  const runCwd = typeof cwd === 'string' && cwd ? cwd : projectPath;
  return {
    SCHEDULED_TASK_TITLE: title,
    SCHEDULED_TASK_CWD: runCwd,
    SCHEDULED_TASK_PROJECT: projectPath,
  };
}

/**
 * §13.5: the always-on predefined-variables block of the agent prompt. Static —
 * it names every variable, says where the agent can read it and why, so the same
 * text describes every run and the agent reads the actual values from the
 * environment (built-ins, parameters) or from the workspace block above
 * (workspace variables).
 * @returns {string} never null (unlike the §12.6 Parameters block)
 */
export function predefinedVarsPromptBlock() {
  const lines = [
    '## Predefined scheduled-task variables',
    '',
    'The app injects these variables into the script gate of every run. Read them from the environment or from this block; never hardcode the task name, the project path or any workspace directory, so the task keeps working from any directory.',
    '',
    'Built-in parameters (script gate env + this session env):',
  ];
  for (const entry of PREDEFINED_TASK_VARS) {
    if (entry.group !== 'builtin') continue;
    lines.push('- ' + entry.name + ' ($' + entry.envName + ') — ' + entry.description + '.');
  }
  lines.push('');
  lines.push(
    'Workspace variables (script gate env; the same values are spelled out in the Scheduled task workspace block above):'
  );
  for (const entry of PREDEFINED_TASK_VARS) {
    if (entry.group !== 'workspace') continue;
    lines.push('- ' + entry.name + ' ($' + entry.envName + ') — ' + entry.description + '.');
  }
  lines.push('');
  lines.push(
    'User-declared parameters are exported as $' +
      PARAM_ENV_PREFIX +
      '<NAME> plus the compact JSON $' +
      PARAMS_ENV_NAME +
      ' to the script gate and to this session (§12.2). They can never replace a predefined variable above.'
  );
  lines.push('');
  lines.push(SESSION_ID_NOTE);
  return lines.join('\n');
}

/**
 * §12.5: Record<string,string> of the §12.2 variables, or null when the task
 * declares no parameters. Resolution failures also yield null; callers that need
 * the reason use resolveParams() first. The §13.1 predefined variables are a
 * separate namespace (builtinParamsEnv / predefinedVarsPromptBlock) and are
 * therefore not part of this null contract.
 */
export function paramEnv(params, overrides) {
  const resolved = resolveParams(params, overrides);
  return resolved.ok ? resolved.env : null;
}

/**
 * §12.5: apply a per-run override map as the *defaults* of a definition list,
 * used by preset installation ("applied to every installed task whose template
 * declares that name"). Names the template does not declare are ignored.
 * @returns {{ ok: true, params } | { ok: false, code, message }}
 */
export function applyParamOverrides(params, overrides) {
  const checkedDefs = normalizeParamDefs(params);
  if (!checkedDefs.ok) return checkedDefs;
  const checkedOverrides = normalizeOverrides(overrides);
  if (!checkedOverrides.ok) return checkedOverrides;
  const overrideMap = checkedOverrides.map;

  const next = [];
  for (const def of checkedDefs.params) {
    const overrideKey = Object.keys(overrideMap).find((key) => key.toLowerCase() === def.name.toLowerCase());
    if (overrideKey === undefined) {
      next.push(def);
      continue;
    }
    const coerced = coerceParamValue(def.type, overrideMap[overrideKey]);
    if (!coerced.ok) {
      return fail(`Parameter "${def.name}" ${coerced.message}`);
    }
    // A default makes the parameter optional: drop the now-meaningless required flag.
    const replaced = { ...def, default: coerced.value };
    delete replaced.required;
    next.push(replaced);
  }
  // Re-normalize so an install override becomes a stored default that is itself
  // bounded (value length, NUL) and keeps the definitions JSON within its cap.
  return normalizeParamDefs(next);
}

function displayValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * §12.6: the Parameters block appended to the workspace block. Returns null when
 * the task declares no parameters; the §13.5 predefined-variables block is always
 * present, so a zero-parameter prompt is no longer byte-identical to pre-§12.
 * @returns {string|null}
 */
export function paramsPromptBlock(params, values) {
  const defs = Array.isArray(params) ? params : [];
  if (!defs.length) return null;
  const source = isPlainObject(values) ? values : {};

  const lines = [
    '## Scheduled task parameters',
    '',
    'This run was started with the parameters below. Their values are fixed for this run:',
    'read them from the environment, never hardcode them.',
    '',
  ];
  for (const def of defs) {
    if (!def || typeof def !== 'object' || typeof def.name !== 'string') continue;
    const envName = paramEnvName(def.name);
    const hasValue = Object.prototype.hasOwnProperty.call(source, def.name);
    const value = hasValue ? `\`${displayValue(source[def.name])}\`` : '(not set)';
    const description = typeof def.description === 'string' && def.description ? ` — ${def.description}` : '';
    lines.push(`- \`${def.name}\` (${def.type ?? DEFAULT_PARAM_TYPE}) = ${value} (env: \`$${envName}\`)${description}`);
  }
  lines.push('');
  lines.push(
    `The same values are exported as compact JSON in \`$${PARAMS_ENV_NAME}\`. Read each parameter from its own \`$${PARAM_ENV_PREFIX}<NAME>\` variable or parse \`$${PARAMS_ENV_NAME}\`.`
  );
  lines.push('');
  lines.push(
    `Reserved variables set by the app (do not overwrite them): ${RESERVED_SCHEDULED_TASK_ENV.map((name) => `\`$${name}\``).join(', ')}.`
  );
  return lines.join('\n');
}

