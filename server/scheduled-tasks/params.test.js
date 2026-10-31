import { describe, it, expect } from 'vitest';

import {
  BUILTIN_PARAMS,
  BUILTIN_PARAM_ENV_NAMES,
  MAX_PARAM_COUNT,
  MAX_PARAM_JSON_BYTES,
  MAX_PARAM_VALUE_LENGTH,
  PARAM_ENV_PREFIX,
  PARAMS_ENV_NAME,
  PREDEFINED_ENV_NAMES,
  PREDEFINED_TASK_VARS,
  RESERVED_SCHEDULED_TASK_ENV,
  SESSION_ID_NOTE,
  applyParamOverrides,
  builtinParamsEnv,
  checkParamValue,
  coerceParamValue,
  normalizeParamDefs,
  paramEnv,
  paramEnvName,
  paramEnvValue,
  paramsPromptBlock,
  parseParamDefs,
  predefinedVarsPromptBlock,
  resolveParams,
} from './params.js';

describe('env contract constants (§12.2)', () => {
  it('exposes the documented prefix and aggregate variable', () => {
    expect(PARAM_ENV_PREFIX).toBe('SCHEDULED_TASK_PARAM_');
    expect(PARAMS_ENV_NAME).toBe('SCHEDULED_TASK_PARAMS');
    expect(paramEnvName('region')).toBe('SCHEDULED_TASK_PARAM_REGION');
    expect(paramEnvName('dryRun')).toBe('SCHEDULED_TASK_PARAM_DRYRUN');
  });

  it('stringifies booleans and numbers the documented way', () => {
    expect(paramEnvValue(true)).toBe('true');
    expect(paramEnvValue(false)).toBe('false');
    expect(paramEnvValue(3)).toBe('3');
    expect(paramEnvValue('eu')).toBe('eu');
  });
});

describe('normalizeParamDefs (§12.1)', () => {
  it('treats missing input as no parameters', () => {
    expect(normalizeParamDefs(undefined)).toEqual({ ok: true, params: [] });
    expect(normalizeParamDefs(null)).toEqual({ ok: true, params: [] });
    expect(normalizeParamDefs([])).toEqual({ ok: true, params: [] });
  });

  it('rejects a non-array input', () => {
    const result = normalizeParamDefs({ name: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('canonicalizes a definition and defaults the type to string', () => {
    const result = normalizeParamDefs([
      { name: 'region', default: 'eu', description: ' target region ' },
      { name: 'threshold', type: 'number', default: '3', required: true },
      { name: 'dryRun', type: 'boolean', default: 'false' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.params).toEqual([
      { name: 'region', type: 'string', default: 'eu', description: 'target region' },
      { name: 'threshold', type: 'number', default: 3, required: true },
      { name: 'dryRun', type: 'boolean', default: false },
    ]);
  });

  it('rejects invalid names and duplicate names (case-insensitively)', () => {
    expect(normalizeParamDefs([{ name: '1bad' }])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(normalizeParamDefs([{ name: 'has-dash' }])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(normalizeParamDefs([{ name: 'a'.repeat(65) }])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(normalizeParamDefs([{ name: 'x' }, { name: 'X' }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });

  it('rejects unknown types, bad descriptions and non-boolean required', () => {
    expect(normalizeParamDefs([{ name: 'x', type: 'date' }])).toMatchObject({ ok: false });
    expect(normalizeParamDefs([{ name: 'x', description: 5 }])).toMatchObject({ ok: false });
    expect(normalizeParamDefs([{ name: 'x', description: 'y'.repeat(501) }])).toMatchObject({ ok: false });
    expect(normalizeParamDefs([{ name: 'x', required: 'yes' }])).toMatchObject({ ok: false });
  });

  it('rejects an uncoercible default (invalid_input at creation)', () => {
    expect(normalizeParamDefs([{ name: 'n', type: 'number', default: 'abc' }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(normalizeParamDefs([{ name: 'b', type: 'boolean', default: 'maybe' }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });

  it('rejects more than 32 parameters', () => {
    const many = Array.from({ length: MAX_PARAM_COUNT + 1 }, (_value, index) => ({ name: 'p' + index }));
    expect(normalizeParamDefs(many)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(normalizeParamDefs(many.slice(0, MAX_PARAM_COUNT)).ok).toBe(true);
  });

  it('rejects a params JSON payload above 16 KiB', () => {
    expect(normalizeParamDefs([{ name: 'blob', default: 'x'.repeat(17000) }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });

    // 32 parameters with 500-char descriptions stay under the limit.
    const many = Array.from({ length: MAX_PARAM_COUNT }, (_value, index) => ({
      name: 'p' + index,
      description: 'y'.repeat(300),
    }));
    expect(normalizeParamDefs(many).ok).toBe(true);
  });
});

describe('parseParamDefs (§12.4)', () => {
  it('reads a JSON string, an already-parsed array and legacy garbage', () => {
    expect(parseParamDefs('[{"name":"a","type":"string"}]')).toEqual([{ name: 'a', type: 'string' }]);
    expect(parseParamDefs([{ name: 'a' }])).toEqual([{ name: 'a', type: 'string' }]);
    expect(parseParamDefs('not json')).toEqual([]);
    expect(parseParamDefs('{"a":1}')).toEqual([]);
    expect(parseParamDefs(null)).toEqual([]);
    expect(parseParamDefs('[]')).toEqual([]);
  });
});

describe('coerceParamValue (§12.3)', () => {
  it('coerces the string forms a form body carries', () => {
    expect(coerceParamValue('number', '3')).toEqual({ ok: true, value: 3 });
    expect(coerceParamValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(coerceParamValue('boolean', 'FALSE')).toEqual({ ok: true, value: false });
    expect(coerceParamValue('string', 3)).toEqual({ ok: true, value: '3' });
    expect(coerceParamValue('number', 'abc')).toMatchObject({ ok: false });
    expect(coerceParamValue('boolean', 'maybe')).toMatchObject({ ok: false });
  });
});

describe('resolveParams (§12.2/§12.3)', () => {
  const defs = [
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'threshold', type: 'number', default: 3 },
    { name: 'dryRun', type: 'boolean', default: false },
  ];

  it('resolves the documented env example', () => {
    const result = resolveParams(defs, {});
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ region: 'eu', threshold: 3, dryRun: false });
    expect(result.json).toBe('{"region":"eu","threshold":3,"dryRun":false}');
    expect(result.env).toEqual({
      SCHEDULED_TASK_PARAM_REGION: 'eu',
      SCHEDULED_TASK_PARAM_THRESHOLD: '3',
      SCHEDULED_TASK_PARAM_DRYRUN: 'false',
      SCHEDULED_TASK_PARAMS: '{"region":"eu","threshold":3,"dryRun":false}',
    });
  });

  it('lets a per-run override win over the default and coerces it', () => {
    const result = resolveParams(defs, { threshold: '7', DRYRUN: 'true' });
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ region: 'eu', threshold: 7, dryRun: true });
  });

  it('fails with missing_required_param when a required parameter has no value', () => {
    const result = resolveParams([{ name: 'token', type: 'string', required: true }], {});
    expect(result).toMatchObject({ ok: false, code: 'missing_required_param' });
  });

  it('rejects an override with no matching definition (invalid_input)', () => {
    const result = resolveParams(defs, { nope: '1' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects an uncoercible override (invalid_input)', () => {
    const result = resolveParams(defs, { threshold: 'abc' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('exports nothing at all when no parameters are declared', () => {
    const result = resolveParams([], {});
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({});
    expect(result.json).toBeNull();
    expect(result.env).toBeNull();
    expect(paramEnv([], {})).toBeNull();
  });

  it('declares the aggregate JSON even when every value is optional and unset', () => {
    const result = resolveParams([{ name: 'note', type: 'string' }], {});
    expect(result.values).toEqual({});
    expect(result.json).toBe('{}');
    expect(result.env).toEqual({ SCHEDULED_TASK_PARAMS: '{}' });
  });

  it('returns null from paramEnv on a resolution failure', () => {
    expect(paramEnv([{ name: 'token', required: true }], {})).toBeNull();
  });
});

describe('applyParamOverrides (§12.5 install)', () => {
  it('replaces matching defaults and ignores names the template does not declare', () => {
    const result = applyParamOverrides(
      [
        { name: 'region', type: 'string', default: 'eu' },
        { name: 'token', type: 'string', required: true },
      ],
      { region: 'us', other: 'x' }
    );
    expect(result.ok).toBe(true);
    expect(result.params).toEqual([
      { name: 'region', type: 'string', default: 'us' },
      { name: 'token', type: 'string', required: true },
    ]);
  });

  it('rejects an uncoercible override', () => {
    expect(applyParamOverrides([{ name: 'n', type: 'number' }], { n: 'abc' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });
});

describe('paramsPromptBlock (§12.6)', () => {
  it('returns null without parameters (only the §13.5 block is always present)', () => {
    expect(paramsPromptBlock([], {})).toBeNull();
    expect(paramsPromptBlock(undefined, {})).toBeNull();
  });

  it('names every parameter, its env variable, value, type and description', () => {
    const block = paramsPromptBlock(
      [
        { name: 'region', type: 'string', default: 'eu', description: 'target region' },
        { name: 'threshold', type: 'number', default: 3 },
      ],
      { region: 'us', threshold: 3 }
    );

    expect(block.startsWith('## Scheduled task parameters')).toBe(true);
    expect(block).toContain('$SCHEDULED_TASK_PARAM_REGION');
    expect(block).toContain('$SCHEDULED_TASK_PARAM_THRESHOLD');
    expect(block).toContain('$SCHEDULED_TASK_PARAMS');
    expect(block).toContain('target region');
    expect(block).toContain('never hardcode');
    expect(block).toContain('SCHEDULED_TASK_ID');
    expect(block).toContain('SCHEDULED_TASK_RUN_DIR');
  });
});

describe('__proto__ as a parameter name (hardening)', () => {
  it('resolves a declared __proto__ parameter into values, json and env', () => {
    const defs = normalizeParamDefs([
      { name: '__proto__', type: 'string', default: 'pwn' },
      { name: 'ok', type: 'string', default: 'yes' },
    ]).params;

    const result = resolveParams(defs, {});

    expect(result.ok).toBe(true);
    expect(Object.keys(result.values)).toEqual(['__proto__', 'ok']);
    expect(Object.prototype.hasOwnProperty.call(result.values, '__proto__')).toBe(true);
    expect(result.values.__proto__).toBe('pwn');
    expect(result.json).toBe('{"__proto__":"pwn","ok":"yes"}');
    expect(result.env.SCHEDULED_TASK_PARAM___PROTO__).toBe('pwn');
    expect(result.env.SCHEDULED_TASK_PARAMS).toBe('{"__proto__":"pwn","ok":"yes"}');
  });

  it('accepts a per-run override for a declared __proto__ parameter', () => {
    const defs = normalizeParamDefs([{ name: '__proto__', type: 'string' }]).params;

    const result = resolveParams(defs, JSON.parse('{"__proto__":"owned"}'));

    expect(result.ok).toBe(true);
    expect(result.values.__proto__).toBe('owned');
    expect(result.env.SCHEDULED_TASK_PARAM___PROTO__).toBe('owned');
  });

  it('rejects an override naming an undeclared __proto__ (Unknown parameter)', () => {
    const defs = normalizeParamDefs([{ name: 'ok', type: 'string' }]).params;

    // JSON.parse creates a real own "__proto__" property, as an HTTP body would.
    const result = resolveParams(defs, JSON.parse('{"__proto__":"x"}'));

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(result.message).toMatch(/Unknown parameter/);
  });

  it('never pollutes Object.prototype in either case', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();

    resolveParams(
      normalizeParamDefs([{ name: '__proto__', type: 'string', default: 'pwn' }]).params,
      {}
    );
    resolveParams(
      normalizeParamDefs([{ name: 'ok', type: 'string' }]).params,
      JSON.parse('{"__proto__":"polluted"}')
    );

    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.prototype.pwn).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect({}.pwn).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });
});


describe('value bounds (§12.1/§12.3)', () => {
  it('exports the 4096-character per-value cap', () => {
    expect(MAX_PARAM_VALUE_LENGTH).toBe(4096);
  });

  it('bounds a stored default (4096 accepted, 4097 rejected)', () => {
    const atLimit = normalizeParamDefs([{ name: 'v', default: 'x'.repeat(MAX_PARAM_VALUE_LENGTH) }]);
    expect(atLimit.ok).toBe(true);
    expect(atLimit.params[0].default.length).toBe(MAX_PARAM_VALUE_LENGTH);

    expect(normalizeParamDefs([{ name: 'v', default: 'x'.repeat(MAX_PARAM_VALUE_LENGTH + 1) }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });

  it('bounds a per-run override (4096 accepted, 4097 rejected)', () => {
    const defs = normalizeParamDefs([{ name: 'v' }]).params;

    const atLimit = resolveParams(defs, { v: 'x'.repeat(MAX_PARAM_VALUE_LENGTH) });
    expect(atLimit.ok).toBe(true);
    expect(atLimit.values.v.length).toBe(MAX_PARAM_VALUE_LENGTH);

    expect(resolveParams(defs, { v: 'x'.repeat(MAX_PARAM_VALUE_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });

  it('bounds overrides by their coerced form (numbers/booleans stay valid)', () => {
    const defs = normalizeParamDefs([
      { name: 'n', type: 'number' },
      { name: 'b', type: 'boolean' },
    ]).params;

    const result = resolveParams(defs, { n: 1e21, b: 'true' });

    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ n: 1e21, b: true });
  });

  it('caps the compact resolved JSON at MAX_PARAM_JSON_BYTES', () => {
    // 5 x 3000 chars stays under the 16 KiB cap; 8 x 3000 crosses it while each
    // value is still under the per-value cap.
    const defs5 = normalizeParamDefs(Array.from({ length: 5 }, (_value, i) => ({ name: 'p' + i }))).params;
    const values5 = Object.fromEntries(defs5.map((def) => [def.name, 'x'.repeat(3000)]));
    const ok = resolveParams(defs5, values5);
    expect(ok.ok).toBe(true);
    expect(ok.json.length).toBeLessThanOrEqual(MAX_PARAM_JSON_BYTES);

    const defs8 = normalizeParamDefs(Array.from({ length: 8 }, (_value, i) => ({ name: 'p' + i }))).params;
    const values8 = Object.fromEntries(defs8.map((def) => [def.name, 'x'.repeat(3000)]));
    expect(resolveParams(defs8, values8)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects NUL in a default and in an override, but allows a literal backslash-u', () => {
    const nul = 'a' + String.fromCharCode(0) + 'b';

    expect(normalizeParamDefs([{ name: 'v', default: nul }])).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(resolveParams(normalizeParamDefs([{ name: 'v' }]).params, { v: nul })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(checkParamValue('v', nul)).toMatchObject({ ok: false, code: 'invalid_input' });
    // The six-character sequence \u0000 is not a NUL and must stay valid.
    expect(checkParamValue('v', 'a\\u0000b')).toEqual({ ok: true });
  });

  it('bounds install overrides (applyParamOverrides) the same way', () => {
    const defs = [{ name: 'v', type: 'string', default: 'ok' }];

    expect(applyParamOverrides(defs, { v: 'x'.repeat(MAX_PARAM_VALUE_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(applyParamOverrides(defs, { v: 'a' + String.fromCharCode(0) })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(applyParamOverrides(defs, { v: 'x'.repeat(MAX_PARAM_VALUE_LENGTH) }).ok).toBe(true);
  });

  it('still resolves __proto__ under the new bounds', () => {
    const defs = normalizeParamDefs([{ name: '__proto__', type: 'string', default: 'pwn' }]).params;

    const result = resolveParams(defs, {});

    expect(result.ok).toBe(true);
    expect(result.values.__proto__).toBe('pwn');
    expect(result.env.SCHEDULED_TASK_PARAM___PROTO__).toBe('pwn');
  });
});

describe('predefined task variables (§13)', () => {
  it('exports title, cwd and project root for every run', () => {
    expect(builtinParamsEnv({ title: 'nightly', project_path: '/proj' }, { cwd: '/proj/sub' })).toEqual({
      SCHEDULED_TASK_TITLE: 'nightly',
      SCHEDULED_TASK_CWD: '/proj/sub',
      SCHEDULED_TASK_PROJECT: '/proj',
    });
  });

  it('defaults cwd to the project path and tolerates missing/unreadable tasks', () => {
    expect(builtinParamsEnv({ title: 't', project_path: '/proj' })).toEqual({
      SCHEDULED_TASK_TITLE: 't',
      SCHEDULED_TASK_CWD: '/proj',
      SCHEDULED_TASK_PROJECT: '/proj',
    });
    // camelCase row shape, and the empty-shape fallbacks.
    expect(builtinParamsEnv({ title: 't', projectPath: '/camel' }).SCHEDULED_TASK_PROJECT).toBe('/camel');
    expect(builtinParamsEnv(null)).toEqual({
      SCHEDULED_TASK_TITLE: '',
      SCHEDULED_TASK_CWD: '',
      SCHEDULED_TASK_PROJECT: '',
    });
    expect(builtinParamsEnv(undefined).SCHEDULED_TASK_CWD).toBe('');
  });

  it('advertises the nine predefined names, grouped, with the env/agent split', () => {
    expect(BUILTIN_PARAMS.map((entry) => entry.envName)).toEqual([
      'SCHEDULED_TASK_TITLE',
      'SCHEDULED_TASK_CWD',
      'SCHEDULED_TASK_PROJECT',
    ]);
    expect(BUILTIN_PARAM_ENV_NAMES).toEqual(BUILTIN_PARAMS.map((entry) => entry.envName));
    expect(PREDEFINED_ENV_NAMES).toEqual([
      'SCHEDULED_TASK_TITLE',
      'SCHEDULED_TASK_CWD',
      'SCHEDULED_TASK_PROJECT',
      'SCHEDULED_TASK_ID',
      'SCHEDULED_TASK_DIR',
      'SCHEDULED_TASK_STATE_DIR',
      'SCHEDULED_TASK_TMP_DIR',
      'SCHEDULED_TASK_RUN_ID',
      'SCHEDULED_TASK_RUN_DIR',
    ]);
    expect(PREDEFINED_TASK_VARS.filter((entry) => entry.group === 'workspace')).toHaveLength(6);
    // Only the three built-ins reach the agent environment (runner.js); the
    // workspace group is script-gate-only and reaches the agent as prompt text.
    expect(PREDEFINED_TASK_VARS.filter((entry) => entry.agentEnv).map((entry) => entry.envName)).toEqual(
      BUILTIN_PARAM_ENV_NAMES
    );
    for (const name of PREDEFINED_ENV_NAMES) {
      expect(RESERVED_SCHEDULED_TASK_ENV).toContain(name);
    }
  });

  it('keeps the param namespace disjoint from every predefined name (§13.2)', () => {
    // A declared parameter is always SCHEDULED_TASK_PARAM_<NAME>; the _PARAM_
    // infix makes the reserved namespace unreachable, whatever the name.
    const names = [
      'title',
      'cwd',
      'project',
      'id',
      'dir',
      'state_dir',
      'tmp_dir',
      'run_id',
      'run_dir',
      'params',
      'SCHEDULED_TASK_TITLE',
    ];
    for (const name of names) {
      expect(paramEnvName(name).startsWith(PARAM_ENV_PREFIX)).toBe(true);
      expect(PREDEFINED_ENV_NAMES).not.toContain(paramEnvName(name));
      expect(RESERVED_SCHEDULED_TASK_ENV).not.toContain(paramEnvName(name));
      expect(paramEnvName(name)).not.toBe(PARAMS_ENV_NAME);
    }

    // A parameter literally named "title" coexists with the predefined variable.
    const defs = normalizeParamDefs([{ name: 'title', type: 'string', default: 'shadow' }]).params;
    const resolved = resolveParams(defs, {});
    expect(resolved.env.SCHEDULED_TASK_PARAM_TITLE).toBe('shadow');
    expect(PREDEFINED_ENV_NAMES).not.toContain('SCHEDULED_TASK_PARAM_TITLE');
    const env = { ...builtinParamsEnv({ title: 'nightly' }), ...resolved.env };
    expect(env.SCHEDULED_TASK_TITLE).toBe('nightly');
    expect(env.SCHEDULED_TASK_PARAM_TITLE).toBe('shadow');
  });

  it('refuses a per-run override that targets a predefined name', () => {
    // Overrides are matched against *declared* names only, so none of these can
    // ever reach a predefined variable.
    for (const key of ['TITLE', 'CWD', 'PROJECT', 'ID', 'DIR', 'RUN_ID', 'SCHEDULED_TASK_CWD', 'PARAMS']) {
      expect(resolveParams([], { [key]: 'hijack' })).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(resolveParams([], {})).toMatchObject({ ok: true, env: null });
  });

  it('describes every predefined variable in the always-on prompt block (§13.5)', () => {
    const block = predefinedVarsPromptBlock();

    expect(typeof block).toBe('string');
    expect(block.startsWith('## Predefined scheduled-task variables')).toBe(true);
    for (const entry of PREDEFINED_TASK_VARS) {
      expect(block).toContain('$' + entry.envName);
      expect(block).toContain(entry.description);
    }
    expect(block).toContain('never hardcode');
    expect(block).toContain('Built-in parameters');
    expect(block).toContain('Workspace variables');
    expect(block).toContain(PARAM_ENV_PREFIX);
    expect(block).toContain(PARAMS_ENV_NAME);
    // §13: the three ids are distinguished and the session id is not an env var.
    expect(block).toContain('NOT a chat session id');
    expect(block).toContain(SESSION_ID_NOTE);
    // The §12.6 Parameters block stays conditional; this block never is.
    expect(paramsPromptBlock([], {})).toBeNull();
  });
});
