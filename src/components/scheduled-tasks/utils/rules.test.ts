import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { RuleDraft } from '../types';
import {
  createDefaultRuleDraft,
  describeRule,
  draftToRule,
  ruleToDraft,
  toDateTimeLocalValue,
  toTaskRule,
} from './rules';

/** Minimal i18n stub: echoes the key plus interpolation options. */
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? key + ':' + JSON.stringify(options) : key) as unknown as TFunction;

function draft(patch: Partial<RuleDraft>): RuleDraft {
  return { ...createDefaultRuleDraft(), ...patch };
}

describe('draftToRule', () => {
  it('rejects intervals shorter than 60 seconds', () => {
    const result = draftToRule(draft({ kind: 'interval', intervalValue: 30, intervalUnit: 'seconds' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('editor.errors.intervalMin');
  });

  it('converts interval values into seconds', () => {
    const result = draftToRule(draft({ kind: 'interval', intervalValue: 90, intervalUnit: 'minutes' }));
    expect(result).toEqual({ ok: true, rule: { kind: 'interval', everySeconds: 5400 } });
  });

  it('rejects a once schedule in the past', () => {
    const past = toDateTimeLocalValue(new Date(Date.now() - 60000).toISOString());
    const result = draftToRule(draft({ kind: 'once', onceAt: past }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('editor.errors.onceFuture');
  });

  it('deduplicates and sorts weekly weekdays', () => {
    const result = draftToRule(draft({ kind: 'weekly', time: '08:30', weekdays: [5, 1, 5, 3] }));
    expect(result.ok).toBe(true);
    if (result.ok && result.rule.kind === 'weekly') {
      expect(result.rule.weekdays).toEqual([1, 3, 5]);
    }
  });

  it('requires at least one weekday', () => {
    const result = draftToRule(draft({ kind: 'weekly', time: '08:30', weekdays: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('editor.errors.weekdaysRequired');
  });

  it('requires exactly five cron fields and collapses whitespace', () => {
    expect(draftToRule(draft({ kind: 'cron', cronExpression: '0 9 * *' })).ok).toBe(false);
    const result = draftToRule(draft({ kind: 'cron', cronExpression: '  0   9  *  *  1-5 ' }));
    expect(result.ok).toBe(true);
    if (result.ok && result.rule.kind === 'cron') {
      expect(result.rule.expression).toBe('0 9 * * 1-5');
    }
  });

  it('requires a valid time of day', () => {
    expect(draftToRule(draft({ kind: 'daily', time: '25:00' })).ok).toBe(false);
    expect(draftToRule(draft({ kind: 'daily', time: '09:15' })).ok).toBe(true);
  });
});

describe('toTaskRule', () => {
  it('fills defaults when the payload omits fields', () => {
    const rule = toTaskRule('daily', {});
    expect(rule.kind).toBe('daily');
    if (rule.kind === 'daily') {
      expect(rule.time).toBe('09:00');
      expect(rule.timeZone.length).toBeGreaterThan(0);
    }
  });

  it('round-trips a cron rule through the editor draft', () => {
    const rule = toTaskRule('cron', { expression: '*/15 * * * *', timeZone: 'UTC' });
    const result = draftToRule(ruleToDraft(rule));
    expect(result.ok).toBe(true);
    if (result.ok && result.rule.kind === 'cron') {
      expect(result.rule.expression).toBe('*/15 * * * *');
      expect(result.rule.timeZone).toBe('UTC');
    }
  });

  it('picks the largest whole interval unit for the draft', () => {
    const result = draftToRule(ruleToDraft(toTaskRule('interval', { everySeconds: 7200 })));
    expect(result).toEqual({ ok: true, rule: { kind: 'interval', everySeconds: 7200 } });
  });
});

describe('describeRule', () => {
  it('includes the time zone for a daily rule', () => {
    const text = describeRule({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, t, 'en');
    expect(text).toContain('Asia/Shanghai');
  });

  it('formats an interval with the localized unit', () => {
    const text = describeRule({ kind: 'interval', everySeconds: 7200 }, t, 'en');
    expect(text).toContain('rule.interval.units.hours');
    expect(text).toContain('"value":2');
  });
});
