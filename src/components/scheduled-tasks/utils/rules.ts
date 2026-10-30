import type { TFunction } from 'i18next';
import type { IntervalUnit, RuleDraft, RuleKind, RulePayload, TaskRule } from '../types';
import { formatDateTime, formatTimeOfDay } from './format';

export const RULE_KINDS: RuleKind[] = ['once', 'interval', 'daily', 'weekly', 'cron'];

export const MIN_INTERVAL_SECONDS = 60;

export const INTERVAL_UNIT_SECONDS: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

let cachedTimeZones: string[] | null = null;

export function getBrowserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Time zone options via Intl.supportedValuesOf (ES2022, not in our lib target so
 * accessed through a guard) with a hand-written fallback list.
 */
export function getTimeZoneOptions(): string[] {
  if (cachedTimeZones) return cachedTimeZones;

  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  let zones: string[] = [];
  if (typeof supportedValuesOf === 'function') {
    try {
      zones = supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
  }

  const browserZone = getBrowserTimeZone();
  const list = Array.from(new Set([browserZone, ...(zones.length > 0 ? zones : FALLBACK_TIME_ZONES)]));
  cachedTimeZones = list;
  return list;
}

/** 2024-01-01 was a Monday, so these reference dates map ISO weekday -> date. */
const WEEKDAY_REFERENCE_DATES: Record<number, string> = {
  1: '2024-01-01',
  2: '2024-01-02',
  3: '2024-01-03',
  4: '2024-01-04',
  5: '2024-01-05',
  6: '2024-01-06',
  7: '2024-01-07',
};

export function isIsoWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

export function getWeekdayLabel(weekday: number, locale?: string): string {
  const iso = WEEKDAY_REFERENCE_DATES[weekday] ?? WEEKDAY_REFERENCE_DATES[1];
  const date = new Date(iso + 'T12:00:00Z');
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(date);
  } catch {
    return String(weekday);
  }
}

export function normalizeRuleKind(value: unknown): RuleKind {
  return typeof value === 'string' && (RULE_KINDS as string[]).includes(value) ? (value as RuleKind) : 'daily';
}

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_PATTERN.test((value ?? '').trim());
}

/** ISO string -> value for an <input type="datetime-local"> (local wall clock). */
export function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) +
    ':' + pad(date.getMinutes())
  );
}

/** datetime-local value -> ISO-8601 with offset (UTC 'Z' form). */
export function dateTimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function defaultOnceAt(): string {
  const date = new Date(Date.now() + 3600 * 1000);
  return toDateTimeLocalValue(date.toISOString());
}

export function createDefaultRuleDraft(
  kind: RuleKind = 'daily',
  timeZone: string = getBrowserTimeZone(),
): RuleDraft {
  return {
    kind,
    onceAt: defaultOnceAt(),
    intervalValue: 1,
    intervalUnit: 'hours',
    time: '09:00',
    timeZone,
    weekdays: [1, 2, 3, 4, 5],
    cronExpression: '0 9 * * 1-5',
  };
}

function readTime(payload: RulePayload, fallback = '09:00'): string {
  return typeof payload.time === 'string' && payload.time ? payload.time : fallback;
}

function readTimeZone(payload: RulePayload): string {
  return typeof payload.timeZone === 'string' && payload.timeZone ? payload.timeZone : getBrowserTimeZone();
}

/** Rebuild a complete, safe TaskRule from an API payload of unknown shape. */
export function toTaskRule(kind: RuleKind, rule: RulePayload | null | undefined): TaskRule {
  const payload = rule ?? {};
  const timeZone = readTimeZone(payload);

  switch (kind) {
    case 'once':
      return { kind: 'once', at: typeof payload.at === 'string' ? payload.at : '' };
    case 'interval':
      return {
        kind: 'interval',
        everySeconds:
          typeof payload.everySeconds === 'number' && payload.everySeconds > 0 ? payload.everySeconds : 3600,
      };
    case 'daily':
      return { kind: 'daily', time: readTime(payload), timeZone };
    case 'weekly': {
      const raw = Array.isArray(payload.weekdays) ? payload.weekdays.filter(isIsoWeekday) : [];
      const weekdays = Array.from(new Set(raw)).sort((a, b) => a - b);
      return { kind: 'weekly', time: readTime(payload), timeZone, weekdays: weekdays.length > 0 ? weekdays : [1] };
    }
    case 'cron':
      return {
        kind: 'cron',
        expression:
          typeof payload.expression === 'string' && payload.expression ? payload.expression : '0 9 * * 1-5',
        timeZone,
      };
  }
}

export function bestIntervalUnit(everySeconds: number): { value: number; unit: IntervalUnit } {
  const seconds = Number.isFinite(everySeconds) && everySeconds > 0 ? everySeconds : 3600;
  if (seconds % INTERVAL_UNIT_SECONDS.days === 0) return { value: seconds / INTERVAL_UNIT_SECONDS.days, unit: 'days' };
  if (seconds % INTERVAL_UNIT_SECONDS.hours === 0) return { value: seconds / INTERVAL_UNIT_SECONDS.hours, unit: 'hours' };
  if (seconds % INTERVAL_UNIT_SECONDS.minutes === 0) return { value: seconds / INTERVAL_UNIT_SECONDS.minutes, unit: 'minutes' };
  return { value: seconds, unit: 'seconds' };
}

export function ruleToDraft(rule: TaskRule): RuleDraft {
  const base = createDefaultRuleDraft(rule.kind);
  switch (rule.kind) {
    case 'once':
      return { ...base, onceAt: toDateTimeLocalValue(rule.at) };
    case 'interval': {
      const { value, unit } = bestIntervalUnit(rule.everySeconds);
      return { ...base, intervalValue: value, intervalUnit: unit };
    }
    case 'daily':
      return { ...base, time: rule.time, timeZone: rule.timeZone };
    case 'weekly':
      return {
        ...base,
        time: rule.time,
        timeZone: rule.timeZone,
        weekdays: rule.weekdays.length > 0 ? Array.from(new Set(rule.weekdays)).sort((a, b) => a - b) : base.weekdays,
      };
    case 'cron':
      return { ...base, cronExpression: rule.expression, timeZone: rule.timeZone };
  }
}

export type DraftValidation = { ok: true; rule: TaskRule } | { ok: false; errorKey: string };

/** Validate the editor draft and convert it into the API rule payload. */
export function draftToRule(draft: RuleDraft): DraftValidation {
  switch (draft.kind) {
    case 'once': {
      const iso = dateTimeLocalToIso(draft.onceAt);
      if (!iso) return { ok: false, errorKey: 'editor.errors.onceRequired' };
      if (new Date(iso).getTime() <= Date.now()) return { ok: false, errorKey: 'editor.errors.onceFuture' };
      return { ok: true, rule: { kind: 'once', at: iso } };
    }
    case 'interval': {
      const raw = Number(draft.intervalValue);
      if (!Number.isFinite(raw) || raw <= 0) return { ok: false, errorKey: 'editor.errors.intervalRequired' };
      const everySeconds = Math.round(raw * INTERVAL_UNIT_SECONDS[draft.intervalUnit]);
      if (everySeconds < MIN_INTERVAL_SECONDS) return { ok: false, errorKey: 'editor.errors.intervalMin' };
      return { ok: true, rule: { kind: 'interval', everySeconds } };
    }
    case 'daily': {
      if (!isValidTimeOfDay(draft.time)) return { ok: false, errorKey: 'editor.errors.timeRequired' };
      if (!draft.timeZone) return { ok: false, errorKey: 'editor.errors.timeZoneRequired' };
      return { ok: true, rule: { kind: 'daily', time: draft.time, timeZone: draft.timeZone } };
    }
    case 'weekly': {
      if (!isValidTimeOfDay(draft.time)) return { ok: false, errorKey: 'editor.errors.timeRequired' };
      if (!draft.timeZone) return { ok: false, errorKey: 'editor.errors.timeZoneRequired' };
      const weekdays = Array.from(new Set(draft.weekdays.filter(isIsoWeekday))).sort((a, b) => a - b);
      if (weekdays.length === 0) return { ok: false, errorKey: 'editor.errors.weekdaysRequired' };
      return { ok: true, rule: { kind: 'weekly', time: draft.time, timeZone: draft.timeZone, weekdays } };
    }
    case 'cron': {
      const expression = draft.cronExpression.trim().replace(/\s+/g, ' ');
      if (!expression) return { ok: false, errorKey: 'editor.errors.cronRequired' };
      if (expression.split(' ').length !== 5) return { ok: false, errorKey: 'editor.errors.cronInvalid' };
      if (!draft.timeZone) return { ok: false, errorKey: 'editor.errors.timeZoneRequired' };
      return { ok: true, rule: { kind: 'cron', expression, timeZone: draft.timeZone } };
    }
  }
}

/** Human readable frequency text ("Daily at 09:00 (Asia/Shanghai)"). */
export function describeRule(rule: TaskRule, t: TFunction, locale?: string): string {
  switch (rule.kind) {
    case 'once':
      return rule.at
        ? t('describe.once', { time: formatDateTime(rule.at, locale) })
        : t('time.unknown');
    case 'interval': {
      const { value, unit } = bestIntervalUnit(rule.everySeconds);
      return t('describe.interval', { value, unit: t('rule.interval.units.' + unit) });
    }
    case 'daily':
      return t('describe.daily', {
        time: formatTimeOfDay(rule.time, locale) || rule.time,
        timeZone: rule.timeZone,
      });
    case 'weekly':
      return t('describe.weekly', {
        days: rule.weekdays.map((weekday) => getWeekdayLabel(weekday, locale)).join(', '),
        time: formatTimeOfDay(rule.time, locale) || rule.time,
        timeZone: rule.timeZone,
      });
    case 'cron':
      return t('describe.cron', { expression: rule.expression, timeZone: rule.timeZone });
  }
}
