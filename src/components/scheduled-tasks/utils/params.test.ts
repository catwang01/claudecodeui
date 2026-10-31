import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../types';
import {
  MAX_PARAMS,
  PREDEFINED_PARAMS,
  PREDEFINED_PARAM_GROUPS,
  coerceParamValue,
  createParamDraft,
  draftsToParams,
  formatParamValue,
  hasParamDefault,
  initialRunInputs,
  normalizeParamDefs,
  paramEnvName,
  paramTooltip,
  paramsToDrafts,
  readRunInput,
  resolveRunOverrides,
  type ParamDraft,
} from './params';

function draft(overrides: Partial<Omit<ParamDraft, 'id'>> = {}): ParamDraft {
  return { ...createParamDraft(), ...overrides };
}

describe('param env contract (section 12.2)', () => {
  it('derives SCHEDULED_TASK_PARAM_ plus the upper-cased name', () => {
    expect(paramEnvName('region')).toBe('SCHEDULED_TASK_PARAM_REGION');
    expect(paramEnvName('dryRun')).toBe('SCHEDULED_TASK_PARAM_DRYRUN');
    expect(paramEnvName('a_1')).toBe('SCHEDULED_TASK_PARAM_A_1');
  });

  it('formats booleans, numbers and strings like the env contract', () => {
    expect(formatParamValue(true)).toBe('true');
    expect(formatParamValue(false)).toBe('false');
    expect(formatParamValue(3)).toBe('3');
    expect(formatParamValue(0.5)).toBe('0.5');
    expect(formatParamValue('eu')).toBe('eu');
    expect(formatParamValue(null)).toBe('');
    expect(formatParamValue(undefined)).toBe('');
  });

  it('builds the chip tooltip from the description and the env var', () => {
    expect(paramTooltip({ name: 'region', description: 'Deploy region' })).toBe(
      'Deploy region · SCHEDULED_TASK_PARAM_REGION',
    );
    expect(paramTooltip({ name: 'token' })).toBe('SCHEDULED_TASK_PARAM_TOKEN');
  });

  it('treats undefined and null as no default', () => {
    expect(hasParamDefault({})).toBe(false);
    expect(hasParamDefault({ default: undefined })).toBe(false);
    expect(hasParamDefault({ default: null as unknown as undefined })).toBe(false);
    expect(hasParamDefault({ default: '' })).toBe(true);
    expect(hasParamDefault({ default: false })).toBe(true);
  });
});

describe('normalizeParamDefs', () => {
  it('reads an array payload defensively', () => {
    const params = normalizeParamDefs([
      { name: 'region', type: 'string', default: 'eu', description: 'Deploy region' },
      { name: 'dryRun', type: 'boolean', default: false, required: false },
      { bogus: true },
      null,
    ]);
    expect(params).toEqual([
      { name: 'region', type: 'string', default: 'eu', description: 'Deploy region' },
      { name: 'dryRun', type: 'boolean', default: false },
    ]);
  });

  it('parses a legacy JSON string and drops unreadable values', () => {
    expect(normalizeParamDefs('[{"name":"x"}]')).toEqual([{ name: 'x' }]);
    expect(normalizeParamDefs('not json')).toEqual([]);
    expect(normalizeParamDefs(null)).toEqual([]);
    expect(normalizeParamDefs({ name: 'x' })).toEqual([]);
  });

  it('drops duplicate names case-insensitively and caps the list at 32', () => {
    expect(normalizeParamDefs([{ name: 'A' }, { name: 'a' }])).toEqual([{ name: 'A' }]);
    const many = Array.from({ length: MAX_PARAMS + 5 }, (_, index) => ({ name: 'p' + index }));
    expect(normalizeParamDefs(many)).toHaveLength(MAX_PARAMS);
  });
});

describe('draftsToParams', () => {
  it('normalizes names, types, coerced defaults and descriptions', () => {
    const result = draftsToParams([
      draft({ name: 'region', type: 'string', default: '  eu  ', description: '  Deploy region  ' }),
      draft({ name: 'threshold', type: 'number', default: '3' }),
      draft({ name: 'dryRun', type: 'boolean', default: 'false' }),
      draft({ name: 'token', required: true }),
    ]);
    expect(result).toEqual({
      ok: true,
      params: [
        { name: 'region', type: 'string', default: '  eu  ', description: 'Deploy region' },
        { name: 'threshold', type: 'number', default: 3 },
        { name: 'dryRun', type: 'boolean', default: false },
        { name: 'token', type: 'string', required: true },
      ],
    });
  });

  it('rejects malformed names', () => {
    expect(draftsToParams([draft({ name: '' })])).toEqual({
      ok: false,
      errorKey: 'editor.params.errors.nameRequired',
    });
    // Surrounding whitespace is rejected outright, not trimmed into a name (N5).
    for (const name of ['1region', 'reg-ion', 'reg ion', ' region ', 'a'.repeat(65)]) {
      expect(draftsToParams([draft({ name })])).toEqual({
        ok: false,
        errorKey: 'editor.params.errors.nameInvalid',
      });
    }
  });

  it('rejects duplicate names case-insensitively', () => {
    expect(draftsToParams([draft({ name: 'Region' }), draft({ name: 'region' })])).toEqual({
      ok: false,
      errorKey: 'editor.params.errors.nameDuplicate',
    });
  });

  it('accepts a __proto__ parameter name (review N2)', () => {
    expect(draftsToParams([draft({ name: '__proto__' })])).toEqual({
      ok: true,
      params: [{ name: '__proto__', type: 'string' }],
    });
  });

  it('rejects more than 32 parameters', () => {
    const many = Array.from({ length: MAX_PARAMS + 1 }, (_, index) => draft({ name: 'p' + index }));
    expect(draftsToParams(many)).toEqual({ ok: false, errorKey: 'editor.params.errors.tooMany' });
  });

  it('rejects type coercion failures', () => {
    expect(draftsToParams([draft({ name: 'n', type: 'number', default: 'abc' })])).toEqual({
      ok: false,
      errorKey: 'editor.params.errors.numberInvalid',
    });
    expect(draftsToParams([draft({ name: 'b', type: 'boolean', default: 'yes' })])).toEqual({
      ok: false,
      errorKey: 'editor.params.errors.booleanInvalid',
    });
  });

  it('keeps required together with a default, matching the server (required is moot)', () => {
    expect(draftsToParams([draft({ name: 'x', default: '1', required: true })])).toEqual({
      ok: true,
      params: [{ name: 'x', type: 'string', default: '1', required: true }],
    });
  });

  // Review N1: a task created through REST/presets/agent tools may carry both, so
  // loading and re-saving it from the UI must not be blocked.
  it('round-trips a server payload that carries both required and a default', () => {
    const serverParams: ParamDef[] = [
      { name: 'region', type: 'string', default: 'eu', required: true },
      { name: 'threshold', type: 'number', default: 3, required: true },
    ];
    const drafts = paramsToDrafts(serverParams);
    expect(drafts.map((entry) => entry.required)).toEqual([true, true]);
    expect(drafts.map((entry) => entry.default)).toEqual(['eu', '3']);
    expect(draftsToParams(drafts)).toEqual({ ok: true, params: serverParams });
  });

  it('rejects descriptions longer than 500 characters', () => {
    const result = draftsToParams([draft({ name: 'x', description: 'y'.repeat(501) })]);
    expect(result).toEqual({ ok: false, errorKey: 'editor.params.errors.description' });
  });

  it('accepts an empty list and rejects a payload over 16 KiB', () => {
    expect(draftsToParams([])).toEqual({ ok: true, params: [] });
    const heavy = Array.from({ length: MAX_PARAMS }, (_, index) =>
      draft({ name: 'p' + index, description: 'y'.repeat(500) }),
    );
    expect(draftsToParams(heavy)).toEqual({ ok: false, errorKey: 'editor.params.errors.tooLarge' });
  });
});

describe('coerceParamValue', () => {
  it('coerces numbers and booleans and passes strings through', () => {
    expect(coerceParamValue('number', ' 42 ')).toEqual({ ok: true, value: 42 });
    expect(coerceParamValue('number', '-1.5')).toEqual({ ok: true, value: -1.5 });
    expect(coerceParamValue('boolean', ' TRUE ')).toEqual({ ok: true, value: true });
    expect(coerceParamValue('boolean', 'false')).toEqual({ ok: true, value: false });
    // Numeric spellings are accepted by the server too (review N5).
    expect(coerceParamValue('boolean', '1')).toEqual({ ok: true, value: true });
    expect(coerceParamValue('boolean', '0')).toEqual({ ok: true, value: false });
    expect(coerceParamValue('string', '  eu ')).toEqual({ ok: true, value: '  eu ' });
  });

  it('rejects non-numeric and non-boolean input', () => {
    expect(coerceParamValue('number', 'NaN').ok).toBe(false);
    expect(coerceParamValue('number', 'Infinity').ok).toBe(false);
    expect(coerceParamValue('boolean', '2').ok).toBe(false);
    expect(coerceParamValue('boolean', 'yes').ok).toBe(false);
  });
});

describe('paramsToDrafts / initialRunInputs', () => {
  it('stringifies stored defaults for the editor and the run dialog', () => {
    const params: ParamDef[] = [
      { name: 'region', type: 'string', default: 'eu' },
      { name: 'threshold', type: 'number', default: 3 },
      { name: 'dryRun', type: 'boolean', default: false },
      { name: 'token', required: true },
    ];
    const drafts = paramsToDrafts(params);
    expect(drafts.map((entry) => entry.default)).toEqual(['eu', '3', 'false', '']);
    expect(drafts.map((entry) => entry.required)).toEqual([false, false, false, true]);
    expect(initialRunInputs(params)).toEqual({
      region: 'eu',
      threshold: '3',
      dryRun: 'false',
      token: '',
    });
    expect(paramsToDrafts(null)).toEqual([]);
    expect(initialRunInputs(undefined)).toEqual({});
  });

  it('renders stored numeric boolean defaults as canonical true/false (review N5)', () => {
    expect(paramsToDrafts([{ name: 'dryRun', type: 'boolean', default: 1 }])[0].default).toBe('true');
    expect(paramsToDrafts([{ name: 'dryRun', type: 'boolean', default: 0 }])[0].default).toBe('false');
    expect(initialRunInputs([{ name: 'dryRun', type: 'boolean', default: 1 }])).toEqual({
      dryRun: 'true',
    });
  });
});

describe('resolveRunOverrides (section 12.3)', () => {
  const params: ParamDef[] = [
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'threshold', type: 'number', default: 3 },
    { name: 'dryRun', type: 'boolean', default: false },
  ];

  it('omits blank inputs so the stored default wins', () => {
    const result = resolveRunOverrides(params, { region: '', threshold: '   ', dryRun: '' });
    expect(result).toEqual({ ok: true, overrides: {} });
  });

  it('prefers a typed override over the default', () => {
    const result = resolveRunOverrides(params, { region: 'us', threshold: '5', dryRun: 'true' });
    expect(result).toEqual({ ok: true, overrides: { region: 'us', threshold: 5, dryRun: true } });
  });

  it('ignores undeclared input keys', () => {
    const result = resolveRunOverrides(params, { region: 'us', nope: 'x' });
    expect(result).toEqual({ ok: true, overrides: { region: 'us' } });
  });

  it('blocks a required parameter that has no default', () => {
    const required: ParamDef[] = [{ name: 'token', required: true }];
    expect(resolveRunOverrides(required, { token: '' })).toEqual({
      ok: false,
      errorKey: 'runParams.errors.required',
      paramName: 'token',
    });
    expect(resolveRunOverrides(required, { token: 'abc' })).toEqual({ ok: true, overrides: { token: 'abc' } });
  });

  it('does not block a required parameter that has a default', () => {
    const required: ParamDef[] = [{ name: 'token', required: true, default: 'fallback' }];
    expect(resolveRunOverrides(required, { token: '' })).toEqual({ ok: true, overrides: {} });
  });

  it('rejects an uncoercible override', () => {
    expect(resolveRunOverrides(params, { threshold: 'abc' })).toEqual({
      ok: false,
      errorKey: 'runParams.errors.invalid',
      paramName: 'threshold',
    });
  });

  it('accepts numeric boolean overrides (review N5)', () => {
    expect(resolveRunOverrides(params, { dryRun: '1' })).toEqual({ ok: true, overrides: { dryRun: true } });
    expect(resolveRunOverrides(params, { dryRun: '0' })).toEqual({ ok: true, overrides: { dryRun: false } });
  });
});

// Review N2: a parameter may legitimately be named __proto__. Plain-object
// indexing falls back to Object.prototype, which used to crash the run dialog
// with "raw.trim is not a function".
describe('__proto__-named parameters (review N2)', () => {
  it('keeps __proto__ as an own key when pre-filling the run dialog', () => {
    const inputs = initialRunInputs([{ name: '__proto__', type: 'string', default: 'x' }]);
    expect(Object.getPrototypeOf(inputs)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(inputs, '__proto__')).toBe(true);
    expect(inputs['__proto__']).toBe('x');
    expect(JSON.stringify(inputs)).toBe('{"__proto__":"x"}');
  });

  it('resolves a __proto__ override without crashing or dropping it', () => {
    const params: ParamDef[] = [{ name: '__proto__', type: 'string', required: true }];
    // A plain object literal cannot carry an own __proto__ key, so build it the
    // way the dialog does.
    const inputs = Object.fromEntries([['__proto__', 'x']]) as Record<string, string>;
    const result = resolveRunOverrides(params, inputs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.prototype.hasOwnProperty.call(result.overrides, '__proto__')).toBe(true);
    expect(result.overrides['__proto__']).toBe('x');
    expect(JSON.stringify(result.overrides)).toBe('{"__proto__":"x"}');
  });

  it('treats a missing __proto__ input as blank instead of Object.prototype', () => {
    expect(resolveRunOverrides([{ name: '__proto__', type: 'string' }], {})).toEqual({
      ok: true,
      overrides: {},
    });
  });

  it('reads only own keys', () => {
    expect(readRunInput({}, '__proto__')).toBe('');
    const own = Object.fromEntries([['__proto__', 'x']]) as Record<string, string>;
    expect(readRunInput(own, '__proto__')).toBe('x');
  });
});

describe('predefined params (section 13.1)', () => {
  it('lists every predefined variable the server exports, in table order', () => {
    expect(PREDEFINED_PARAMS.map((param) => param.envName)).toEqual([
      'SCHEDULED_TASK_ID',
      'SCHEDULED_TASK_TITLE',
      'SCHEDULED_TASK_PROJECT',
      'SCHEDULED_TASK_CWD',
      'SCHEDULED_TASK_DIR',
      'SCHEDULED_TASK_RUN_ID',
      'SCHEDULED_TASK_RUN_DIR',
      'SCHEDULED_TASK_PARAM_<NAME>',
      'SCHEDULED_TASK_PARAMS',
    ]);
    expect(PREDEFINED_PARAM_GROUPS).toEqual(['task', 'workspace', 'params']);
    expect(PREDEFINED_PARAMS.every((param) => PREDEFINED_PARAM_GROUPS.includes(param.group))).toBe(true);
  });

  it('keeps the declared-parameter namespace disjoint from every reserved variable (13.2)', () => {
    for (const param of PREDEFINED_PARAMS) {
      // The 'params' group IS the declared-parameter namespace.
      if (param.group === 'params') continue;
      expect(paramEnvName(param.name)).toBe('SCHEDULED_TASK_PARAM_' + param.name);
      expect(paramEnvName(param.name)).not.toBe(param.envName);
      expect(param.envName).not.toContain('SCHEDULED_TASK_PARAM_');
    }
    expect(paramEnvName('title')).toBe('SCHEDULED_TASK_PARAM_TITLE');
    expect(PREDEFINED_PARAMS.map((param) => param.envName)).not.toContain(paramEnvName('title'));
  });

  it('removed state/tmp presets (13.4: the framework does not prescribe state layout)', () => {
    const names = PREDEFINED_PARAMS.map((param) => param.envName);
    expect(names).not.toContain('SCHEDULED_TASK_STATE_DIR');
    expect(names).not.toContain('SCHEDULED_TASK_TMP_DIR');
  });
});
