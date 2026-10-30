// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  RULE_KINDS,
  computeNextRun,
  describeRule,
  isValidTimeZone,
  normalizeRule,
  validateRule,
} from './rules.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

describe('rules module surface', () => {
  it('exports the five rule kinds in contract order', () => {
    expect(RULE_KINDS).toEqual(['once', 'interval', 'daily', 'weekly', 'cron']);
  });

  it('validates IANA time zones through Intl', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('once rules', () => {
  it('accepts a future ISO timestamp with an offset and canonicalizes it', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = validateRule({ kind: 'once', at: future });
    expect(result.ok).toBe(true);
    expect(result.rule.kind).toBe('once');
    expect(result.rule.at).toBe(future);
    expect(result.rule.atMs).toBe(at(future));
  });

  it('rejects a timestamp in the past at validation time', () => {
    const result = validateRule({ kind: 'once', at: '2020-01-01T00:00:00.000Z' });
    expect(result).toEqual({
      ok: false,
      code: 'invalid_schedule_time',
      message: "'once' time must be strictly in the future",
    });
  });

  it('rejects malformed or offset-less timestamps', () => {
    expect(validateRule({ kind: 'once', at: '2030-01-01T00:00:00' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'once', at: '2030-01-01' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'once', at: 'not-a-date' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'once' }).code).toBe('invalid_schedule_time');
    expect(codeOf(() => normalizeRule({ kind: 'once', at: '2030-01-01T00:00:00' }))).toBe('invalid_schedule_time');
  });

  it('returns the instant while it is in the future and null once exhausted', () => {
    const rule = { kind: 'once', at: '2030-01-01T00:00:00.000Z' };
    expect(computeNextRun(rule, at('2029-12-31T00:00:00Z'))).toBe(at('2030-01-01T00:00:00Z'));
    expect(computeNextRun(rule, at('2030-01-01T00:00:00Z'))).toBeNull();
    expect(computeNextRun({ kind: 'once', at: '2020-01-01T00:00:00.000Z' }, at('2026-01-01T00:00:00Z'))).toBeNull();
    expect(computeNextRun({ kind: 'once', at: '2020-01-01T00:00:00.000Z' })).toBeNull();
  });
});

describe('interval rules', () => {
  it('rejects intervals below 60 seconds or non-integers', () => {
    expect(validateRule({ kind: 'interval', everySeconds: 30 }).code).toBe('invalid_interval');
    expect(validateRule({ kind: 'interval', everySeconds: 59 }).code).toBe('invalid_interval');
    expect(validateRule({ kind: 'interval', everySeconds: 60.5 }).code).toBe('invalid_interval');
    expect(validateRule({ kind: 'interval', everySeconds: '300' }).code).toBe('invalid_interval');
    expect(validateRule({ kind: 'interval' }).code).toBe('invalid_interval');
    expect(validateRule({ kind: 'interval', everySeconds: 60 }).ok).toBe(true);
  });

  it('schedules the next run one interval after the reference moment', () => {
    const plain = normalizeRule({ kind: 'interval', everySeconds: 60 });
    expect(computeNextRun(plain, 0)).toBe(60_000);
    expect(computeNextRun(plain, at('2026-01-01T00:00:00Z'))).toBe(at('2026-01-01T00:01:00Z'));
  });

  it('stays anchored to an explicit anchor and never returns the reference instant', () => {
    const anchored = normalizeRule({ kind: 'interval', everySeconds: 300, anchorMs: 1_000_000 });
    expect(anchored.anchorMs).toBe(1_000_000);
    expect(computeNextRun(anchored, 1_000_000)).toBe(1_300_000);
    expect(computeNextRun(anchored, 1_000_001)).toBe(1_300_000);
    expect(computeNextRun(anchored, 1_500_000)).toBe(1_600_000);
    expect(computeNextRun(anchored, 0)).toBe(1_000_000);
  });
});

describe('daily rules', () => {
  it('picks the same local day when the wall time is still ahead', () => {
    const rule = { kind: 'daily', time: '09:30', timeZone: 'UTC' };
    expect(computeNextRun(rule, at('2026-01-01T05:00:00Z'))).toBe(at('2026-01-01T09:30:00Z'));
  });

  it('rolls to the next local day when the wall time has passed', () => {
    const rule = { kind: 'daily', time: '09:30', timeZone: 'UTC' };
    expect(computeNextRun(rule, at('2026-01-01T10:00:00Z'))).toBe(at('2026-01-02T09:30:00Z'));
    expect(computeNextRun(rule, at('2026-01-01T09:30:00Z'))).toBe(at('2026-01-02T09:30:00Z'));
  });

  it('interprets the wall clock in the requested time zone', () => {
    expect(
      computeNextRun({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, at('2026-01-01T00:00:00Z'))
    ).toBe(at('2026-01-01T01:00:00Z'));
    expect(
      computeNextRun({ kind: 'daily', time: '09:00:30', timeZone: 'Asia/Shanghai' }, at('2026-01-01T00:00:00Z'))
    ).toBe(at('2026-01-01T01:00:30Z'));
  });

  it('rejects invalid times, ranges and zones with the right codes', () => {
    expect(validateRule({ kind: 'daily', time: '25:00', timeZone: 'UTC' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'daily', time: '09:60', timeZone: 'UTC' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'daily', time: '9', timeZone: 'UTC' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'daily', timeZone: 'UTC' }).code).toBe('invalid_schedule_time');
    expect(validateRule({ kind: 'daily', time: '09:00', timeZone: 'Not/AZone' }).code).toBe('invalid_time_zone');
    expect(validateRule({ kind: 'daily', time: '09:00' }).code).toBe('invalid_time_zone');
  });
});

describe('weekly rules', () => {
  it('selects the next matching ISO weekday', () => {
    // 2026-01-01 is a Thursday.
    expect(
      computeNextRun({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [1] }, at('2026-01-01T00:00:00Z'))
    ).toBe(at('2026-01-05T08:00:00Z'));
    expect(
      computeNextRun({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [5] }, at('2026-01-01T00:00:00Z'))
    ).toBe(at('2026-01-02T08:00:00Z'));
    expect(
      computeNextRun({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [1] }, at('2026-01-05T08:00:00Z'))
    ).toBe(at('2026-01-12T08:00:00Z'));
  });

  it('normalizes weekdays to unique ascending ISO order', () => {
    const rule = normalizeRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [7, 3, 1, 3] });
    expect(rule.weekdays).toEqual([1, 3, 7]);
    // 2026-01-01 is a Thursday, so the next Mon/Wed/Sun slot is Sunday 2026-01-04.
    expect(computeNextRun(rule, at('2026-01-01T00:00:00Z'))).toBe(at('2026-01-04T08:00:00Z'));
  });

  it('rejects out-of-range or empty weekday lists', () => {
    expect(validateRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [0] }).code).toBe('invalid_weekdays');
    expect(validateRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [8] }).code).toBe('invalid_weekdays');
    expect(validateRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [] }).code).toBe('invalid_weekdays');
    expect(validateRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: ['Mon'] }).code).toBe('invalid_weekdays');
    expect(validateRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC' }).code).toBe('invalid_weekdays');
  });
});

describe('cron rules', () => {
  it('normalizes whitespace and expands the Vixie subset', () => {
    const rule = normalizeRule({ kind: 'cron', expression: '  */15   9-17 * * 1-5 ', timeZone: 'UTC' });
    expect(rule.expression).toBe('*/15 9-17 * * 1-5');
    expect(rule.fields.minute).toEqual([0, 15, 30, 45]);
    expect(rule.fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(rule.fields.dayOfMonth).toHaveLength(31);
    expect(rule.fields.month).toHaveLength(12);
    expect(rule.fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(rule.domRestricted).toBe(false);
    expect(rule.dowRestricted).toBe(true);
  });

  it('computes */15 9-17 * * 1-5 across the week', () => {
    const rule = { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' };
    expect(computeNextRun(rule, at('2026-01-01T00:00:00Z'))).toBe(at('2026-01-01T09:00:00Z'));
    expect(computeNextRun(rule, at('2026-01-01T09:07:00Z'))).toBe(at('2026-01-01T09:15:00Z'));
    expect(computeNextRun(rule, at('2026-01-01T17:45:00Z'))).toBe(at('2026-01-02T09:00:00Z'));
    expect(computeNextRun(rule, at('2026-01-02T17:59:00Z'))).toBe(at('2026-01-05T09:00:00Z'));
  });

  it('applies OR semantics when both day fields are restricted', () => {
    const rule = { kind: 'cron', expression: '0 0 15 * 3', timeZone: 'UTC' };
    // Wednesday 2026-01-07 happens before the 15th.
    expect(computeNextRun(rule, at('2026-01-01T00:00:01Z'))).toBe(at('2026-01-07T00:00:00Z'));
    // The 15th is the next match after Wednesday the 14th.
    expect(computeNextRun(rule, at('2026-01-14T00:00:01Z'))).toBe(at('2026-01-15T00:00:00Z'));
  });

  it('applies AND semantics when only one day field is restricted', () => {
    expect(computeNextRun({ kind: 'cron', expression: '0 0 15 * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBe(
      at('2026-01-15T00:00:00Z')
    );
    expect(computeNextRun({ kind: 'cron', expression: '0 0 * * 1', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBe(
      at('2026-01-05T00:00:00Z')
    );
  });

  it('supports month fields, ranges, lists and steps', () => {
    expect(computeNextRun({ kind: 'cron', expression: '0 0 1 3 *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBe(
      at('2026-03-01T00:00:00Z')
    );
    expect(computeNextRun({ kind: 'cron', expression: '0 12,18 * * *', timeZone: 'UTC' }, at('2026-01-01T13:00:00Z'))).toBe(
      at('2026-01-01T18:00:00Z')
    );
    expect(computeNextRun({ kind: 'cron', expression: '0 0-6/2 * * *', timeZone: 'UTC' }, at('2026-01-01T03:00:00Z'))).toBe(
      at('2026-01-01T04:00:00Z')
    );
    expect(computeNextRun({ kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' }, at('2026-01-01T00:00:00Z'))).toBe(
      at('2026-01-01T01:00:00Z')
    );
  });

  it('returns null for a cron that can never match again', () => {
    expect(computeNextRun({ kind: 'cron', expression: '0 0 30 2 *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('rejects malformed expressions with invalid_cron', () => {
    const bad = [
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      '1-5-7 * * * *',
      'a * * * *',
      '1,,2 * * * *',
    ];
    for (const expression of bad) {
      expect(validateRule({ kind: 'cron', expression, timeZone: 'UTC' }).code).toBe('invalid_cron');
    }
    expect(validateRule({ kind: 'cron', timeZone: 'UTC' }).code).toBe('invalid_cron');
    expect(validateRule({ kind: 'cron', expression: '0 0 * * *', timeZone: 'Not/AZone' }).code).toBe('invalid_time_zone');
  });

  it('treats 0 and 7 as Sunday', () => {
    expect(normalizeRule({ kind: 'cron', expression: '0 0 * * 0', timeZone: 'UTC' }).fields.dayOfWeek).toEqual([0]);
    expect(normalizeRule({ kind: 'cron', expression: '0 0 * * 7', timeZone: 'UTC' }).fields.dayOfWeek).toEqual([0]);
    // 2026-01-01 is a Thursday; the next Sunday is 2026-01-04.
    expect(computeNextRun({ kind: 'cron', expression: '0 0 * * 0', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toBe(
      at('2026-01-04T00:00:00Z')
    );
  });
});

describe('DST handling', () => {
  it('skips a local wall time that does not exist during spring forward', () => {
    // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30 is missing.
    const from = at('2026-03-08T05:00:00Z');
    expect(computeNextRun({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, from)).toBe(
      at('2026-03-09T06:30:00Z')
    );
    expect(computeNextRun({ kind: 'cron', expression: '30 2 * * *', timeZone: 'America/New_York' }, from)).toBe(
      at('2026-03-09T06:30:00Z')
    );
    expect(computeNextRun({ kind: 'weekly', time: '02:30', timeZone: 'America/New_York', weekdays: [7] }, from)).toBe(
      at('2026-03-15T06:30:00Z')
    );
  });

  it('picks the earlier instant for a southern-hemisphere fall-back', () => {
    // Australia/Sydney 2026-04-05: 03:00 AEDT falls back to 02:00 AEST, so 02:30 happens twice.
    const from = at('2026-04-04T14:00:00Z');
    expect(computeNextRun({ kind: 'daily', time: '02:30', timeZone: 'Australia/Sydney' }, from)).toBe(
      at('2026-04-04T15:30:00Z')
    );
  });

  it('skips a southern-hemisphere spring-forward gap', () => {
    // Australia/Sydney 2026-10-04: 02:00 AEST jumps to 03:00 AEDT, so 02:30 is missing.
    const from = at('2026-10-03T15:00:00Z');
    expect(computeNextRun({ kind: 'daily', time: '02:30', timeZone: 'Australia/Sydney' }, from)).toBe(
      at('2026-10-04T15:30:00Z')
    );
  });

  it('picks the earlier instant for an ambiguous fall-back wall time', () => {
    // America/New_York 2026-11-01: 01:30 happens twice (EDT then EST).
    const from = at('2026-11-01T04:00:00Z');
    expect(computeNextRun({ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, from)).toBe(
      at('2026-11-01T05:30:00Z')
    );
  });
});

describe('describeRule', () => {
  it('renders human readable English for every kind', () => {
    expect(describeRule({ kind: 'once', at: '2030-01-01T00:00:00.000Z' })).toBe('Once at 2030-01-01T00:00:00.000Z');
    expect(describeRule({ kind: 'interval', everySeconds: 300 })).toBe('Every 5 minutes');
    expect(describeRule({ kind: 'interval', everySeconds: 3600 })).toBe('Every 1 hour');
    expect(describeRule({ kind: 'interval', everySeconds: 90 })).toBe('Every 90 seconds');
    expect(describeRule({ kind: 'daily', time: '09:30', timeZone: 'UTC' })).toBe('Daily at 09:30 (UTC)');
    expect(describeRule({ kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [1, 3] })).toBe(
      'Weekly on Mon, Wed at 08:00 (UTC)'
    );
    expect(describeRule({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' })).toBe(
      'Cron "*/15 9-17 * * 1-5" (UTC)'
    );
  });
});

describe('validateRule and normalizeRule', () => {
  it('never throws and reports invalid_rule for unknown or malformed input', () => {
    expect(validateRule(null)).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule(undefined)).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule(42)).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule('cron')).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule([])).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule({})).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule({ kind: 'nope' })).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect(validateRule(null).message).toEqual(expect.any(String));
  });

  it('normalizeRule throws an Error carrying a code', () => {
    expect(codeOf(() => normalizeRule({ kind: 'nope' }))).toBe('invalid_rule');
    expect(codeOf(() => normalizeRule(null))).toBe('invalid_rule');
  });

  it('is idempotent: normalized rules can be normalized again and computed from', () => {
    for (const input of [
      { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
      { kind: 'interval', everySeconds: 300 },
      { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
      { kind: 'weekly', time: '08:00', timeZone: 'Europe/Berlin', weekdays: [5, 1] },
      { kind: 'cron', expression: '  */15 9-17 * * 1-5 ', timeZone: 'America/New_York' },
    ]) {
      const normalized = normalizeRule(input);
      expect(normalizeRule(normalized)).toEqual(normalized);
      const reference = at('2026-01-01T00:00:00Z');
      expect(computeNextRun(normalized, reference)).toEqual(computeNextRun(input, reference));
    }
  });

  it('returns epochs strictly greater than the reference moment', () => {
    const reference = at('2026-06-15T12:34:56Z');
    const rules = [
      { kind: 'interval', everySeconds: 60 },
      { kind: 'daily', time: '12:34', timeZone: 'UTC' },
      { kind: 'weekly', time: '12:34', timeZone: 'UTC', weekdays: [1] },
      { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
    ];
    for (const rule of rules) {
      const next = computeNextRun(rule, reference);
      expect(typeof next).toBe('number');
      expect(Number.isInteger(next)).toBe(true);
      expect(next > reference).toBe(true);
      expect(iso(next)).toEqual(expect.any(String));
    }
  });
});
