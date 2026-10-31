import type { ParamDef, ParamType } from '../types';

/**
 * Pure helpers for declared task parameters.
 *
 * Mirrors docs/scheduled-tasks.md section 12.1 (model / limits) and section 12.2
 * (environment variable contract). Everything here is side-effect free so the
 * editor, the run dialog and the cards can share one source of truth.
 */

/** Section 12.1: ^[A-Za-z_][A-Za-z0-9_]{0,63}$ */
export const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PARAM_NAME_MAX_LENGTH = 64;
export const PARAM_DESCRIPTION_MAX_LENGTH = 500;

/** Section 12.1: at most 32 parameters per task and at most 16 KiB of JSON. */
export const MAX_PARAMS = 32;
export const PARAMS_JSON_MAX_BYTES = 16 * 1024;

/** Section 12.2: derived env var name and the compact-JSON escape hatch. */
export const PARAM_ENV_PREFIX = 'SCHEDULED_TASK_PARAM_';
export const PARAMS_ENV_NAME = 'SCHEDULED_TASK_PARAMS';

/** One of the section 13.1 built-in parameters. */
export type BuiltinParam = {
  /** Short name; also the i18n key suffix under editor.params.builtins. */
  name: string;
  /** The environment variable every run exports. */
  envName: string;
};

/**
 * Section 13.1: built-in parameters exported on every run, in the reserved
 * SCHEDULED_TASK_* namespace. A declared parameter is always
 * SCHEDULED_TASK_PARAM_<NAME>, so it can never replace one (section 13.2).
 */
export const BUILTIN_PARAMS: BuiltinParam[] = [
  { name: 'TITLE', envName: 'SCHEDULED_TASK_TITLE' },
  { name: 'CWD', envName: 'SCHEDULED_TASK_CWD' },
  { name: 'PROJECT', envName: 'SCHEDULED_TASK_PROJECT' },
];

export const PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean'];

export function isParamType(value: unknown): value is ParamType {
  return typeof value === 'string' && (PARAM_TYPES as string[]).includes(value);
}

/** Env var a resolved parameter is exported as (section 12.2). */
export function paramEnvName(name: string): string {
  return PARAM_ENV_PREFIX + (name ?? '').toUpperCase();
}

/**
 * Chip tooltip/label content required by section 12.7: the description plus
 * the derived SCHEDULED_TASK_PARAM_<NAME> env var.
 */
export function paramTooltip(def: Pick<ParamDef, 'name' | 'description'>): string {
  const env = paramEnvName(def.name);
  return def.description ? def.description + ' · ' + env : env;
}

/** A parameter with a default always resolves, so required is meaningless then. */
export function hasParamDefault(def: Pick<ParamDef, 'default'>): boolean {
  return def.default !== undefined && def.default !== null;
}

/** Booleans are 'true'/'false', numbers String(value), strings verbatim (12.2). */
export function formatParamValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

/**
 * Defensive read of a params payload coming from the API (or from a
 * params_json TEXT column the caller already parsed). Unreadable legacy
 * values read as an empty list, mirroring the server behaviour in section 12.4.
 */
export function normalizeParamDefs(value: unknown): ParamDef[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const out: ParamDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const def: ParamDef = { name };
    if (isParamType(record.type)) def.type = record.type;
    if (
      typeof record.default === 'string' ||
      typeof record.default === 'number' ||
      typeof record.default === 'boolean'
    ) {
      def.default = record.default;
    }
    if (typeof record.description === 'string' && record.description) def.description = record.description;
    if (record.required === true) def.required = true;

    out.push(def);
    if (out.length >= MAX_PARAMS) break;
  }
  return out;
}

/** Parameters declared by a task/run payload (never null). */
export function taskParams(value: unknown): ParamDef[] {
  return normalizeParamDefs(value);
}

// --- Editor drafts -----------------------------------------------------------

/** Editable, HTML-input-friendly representation of one ParamDef. */
export interface ParamDraft {
  /** Stable React key; not part of the API payload. */
  id: string;
  name: string;
  type: ParamType;
  /** Raw editor text; empty means no default. */
  default: string;
  description: string;
  required: boolean;
}

let paramDraftSeq = 0;

function nextDraftId(): string {
  paramDraftSeq += 1;
  return 'param-' + paramDraftSeq;
}

export function createParamDraft(overrides: Partial<Omit<ParamDraft, 'id'>> = {}): ParamDraft {
  return {
    id: nextDraftId(),
    name: '',
    type: 'string',
    default: '',
    description: '',
    required: false,
    ...overrides,
  };
}

/** Stored ParamDef -> editor draft (the default is stringified for the input). */
export function paramToDraft(def: ParamDef): ParamDraft {
  return {
    id: nextDraftId(),
    name: def.name,
    type: isParamType(def.type) ? def.type : 'string',
    default: runInputValue(def),
    description: typeof def.description === 'string' ? def.description : '',
    required: def.required === true,
  };
}

export function paramsToDrafts(params: unknown): ParamDraft[] {
  return normalizeParamDefs(params).map(paramToDraft);
}

export type ParamTypeCoercion =
  | { ok: true; value: string | number | boolean }
  | { ok: false; errorKey: string; paramName?: string };

/**
 * Coerce one raw editor/runtime string into the declared type (section 12.3).
 * Blank input is not a value and must be handled by the caller.
 */
export function coerceParamValue(
  type: ParamType,
  raw: string,
  paramName?: string,
): ParamTypeCoercion {
  if (type === 'number') {
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!trimmed || !Number.isFinite(value)) {
      return { ok: false, errorKey: 'editor.params.errors.numberInvalid', paramName };
    }
    return { ok: true, value };
  }
  if (type === 'boolean') {
    // Match the server: true/false plus the numeric spellings 1/0 (review N5).
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1') return { ok: true, value: true };
    if (trimmed === 'false' || trimmed === '0') return { ok: true, value: false };
    return { ok: false, errorKey: 'editor.params.errors.booleanInvalid', paramName };
  }
  return { ok: true, value: raw };
}

export type ParamsValidation =
  | { ok: true; params: ParamDef[] }
  | { ok: false; errorKey: string };

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return value.length;
}

/** Validate editor drafts and convert them into the API ParamDef payload. */
export function draftsToParams(drafts: ParamDraft[]): ParamsValidation {
  if (drafts.length > MAX_PARAMS) return { ok: false, errorKey: 'editor.params.errors.tooMany' };

  const params: ParamDef[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    // Match the server: surrounding whitespace is rejected, not trimmed into a
    // different name (review N5). The raw name is what gets stored.
    const name = draft.name;
    if (!name) return { ok: false, errorKey: 'editor.params.errors.nameRequired' };
    if (!PARAM_NAME_PATTERN.test(name)) return { ok: false, errorKey: 'editor.params.errors.nameInvalid' };

    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, errorKey: 'editor.params.errors.nameDuplicate' };
    seen.add(key);

    const description = draft.description.trim();
    if (description.length > PARAM_DESCRIPTION_MAX_LENGTH) {
      return { ok: false, errorKey: 'editor.params.errors.description' };
    }

    const def: ParamDef = { name, type: draft.type };
    const hasDefault = draft.default.trim() !== '';

    // The server accepts required together with a default and lets the default
    // win (required is moot then), so both are preserved here without erroring:
    // a task created via REST/presets/agent tools must be re-savable from the UI.
    if (hasDefault) {
      const coerced = coerceParamValue(draft.type, draft.default, name);
      if (!coerced.ok) return { ok: false, errorKey: coerced.errorKey };
      def.default = coerced.value;
    }
    if (description) def.description = description;
    if (draft.required) def.required = true;

    params.push(def);
  }

  if (utf8ByteLength(JSON.stringify(params)) > PARAMS_JSON_MAX_BYTES) {
    return { ok: false, errorKey: 'editor.params.errors.tooLarge' };
  }
  return { ok: true, params };
}

// --- Manual run --------------------------------------------------------------

/** Run dialog input value for one parameter (its default, or blank). */
export function runInputValue(def: ParamDef): string {
  if (!hasParamDefault(def)) return '';
  const raw = formatParamValue(def.default);
  // The server also accepts 1/0 for booleans; the editor and the run dialog
  // only offer true/false, so render the canonical spelling (review N5).
  if (def.type === 'boolean') {
    const coerced = coerceParamValue('boolean', raw);
    if (coerced.ok) return coerced.value ? 'true' : 'false';
  }
  return raw;
}

/**
 * Read one dialog input by parameter name. hasOwnProperty keeps a name such
 * as __proto__ from resolving to Object.prototype (review N2).
 */
export function readRunInput(inputs: Record<string, string>, name: string): string {
  return Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : '';
}

/**
 * Prefill for the Run with parameters dialog: the current defaults.
 * Object.fromEntries makes a parameter named __proto__ an own property
 * instead of mutating the prototype (review N2).
 */
export function initialRunInputs(params: unknown): Record<string, string> {
  return Object.fromEntries(normalizeParamDefs(params).map((def) => [def.name, runInputValue(def)]));
}

export type RunOverrides =
  | { ok: true; overrides: Record<string, unknown> }
  | { ok: false; errorKey: string; paramName: string };

/**
 * Turn raw dialog inputs into the override map for POST /:id/run (section 12.3).
 * Blank input is omitted so the stored default wins; a required parameter with
 * no default blocks the run.
 */
export function resolveRunOverrides(
  params: unknown,
  inputs: Record<string, string>,
): RunOverrides {
  const entries: Array<[string, unknown]> = [];
  for (const def of normalizeParamDefs(params)) {
    const raw = readRunInput(inputs, def.name);
    if (raw.trim() === '') {
      if (def.required && !hasParamDefault(def)) {
        return { ok: false, errorKey: 'runParams.errors.required', paramName: def.name };
      }
      continue;
    }
    const type: ParamType = isParamType(def.type) ? def.type : 'string';
    const coerced = coerceParamValue(type, raw, def.name);
    if (!coerced.ok) {
      return { ok: false, errorKey: 'runParams.errors.invalid', paramName: def.name };
    }
    entries.push([def.name, coerced.value]);
  }
  // Object.fromEntries keeps names such as __proto__ as own keys; assigning
  // into a plain object would silently drop them (review N2).
  return { ok: true, overrides: Object.fromEntries(entries) };
}
