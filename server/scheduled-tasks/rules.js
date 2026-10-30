// Scheduled-task rule engine — frozen contract: docs/scheduled-tasks.md section 4.
//
// Pure: no I/O, no dependencies (Intl only). The only clock read lives in
// validateRule(), which enforces "once must be strictly in the future at
// create/update time". normalizeRule() stays time-independent so that
// computeNextRun() can report an exhausted one-shot ('once' in the past)
// as null instead of throwing.

export const RULE_KINDS = ['once', 'interval', 'daily', 'weekly', 'cron'];

const MAX_DAY_SCAN = 366 * 5; // cron: give up after ~5 years (e.g. '0 0 31 2 *')

const ISO_WEEKDAY_SHORT = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
];

function ruleError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── Timezone helpers (Intl only) ───────────────────────────────────────────

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// True when Intl can resolve the identifier as an IANA time zone.
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallParts(timeZone, ms) {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetMsAt(timeZone, ms) {
  const p = wallParts(timeZone, ms);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

function sameWall(p, wall) {
  return (
    p.year === wall.year &&
    p.month === wall.month &&
    p.day === wall.day &&
    p.hour === wall.hour &&
    p.minute === wall.minute &&
    p.second === wall.second
  );
}

// Convert a local wall-clock time in timeZone to an epoch-ms instant.
// Returns null when the wall time does not exist (DST spring-forward gap).
// When it is ambiguous (fall-back overlap) the earlier instant wins.
function wallToUtc(timeZone, wall) {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const candidates = new Set();
  // Probe the zone offset one day before, at and one day after the target. A DST
  // shift moves the wall clock by a couple of hours at most, so this generates
  // both instants of an ambiguous (fall-back) wall time regardless of whether the
  // transition happens before or after the target in UTC - the naive two-probe
  // form misses the earlier instant for southern-hemisphere transitions.
  for (const probe of [asUtc - 86400000, asUtc, asUtc + 86400000]) {
    candidates.add(asUtc - offsetMsAt(timeZone, probe));
  }

  const valid = [];
  for (const ms of candidates) {
    if (sameWall(wallParts(timeZone, ms), wall)) valid.push(ms);
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => a - b);
  return valid[0];
}

function addDays(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

// ISO weekday for a calendar date: Mon=1 ... Sun=7.
function isoWeekday(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

// ─── Value parsing ──────────────────────────────────────────────────────────

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseTimeOfDay(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_OF_DAY_RE.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function formatTimeOfDay(time) {
  const hh = String(time.hour).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');
  if (!time.second) return hh + ':' + mm;
  return hh + ':' + mm + ':' + String(time.second).padStart(2, '0');
}

function parseAnchor(rule) {
  for (const key of ['anchorMs', 'anchorAt']) {
    const raw = rule[key];
    if (raw === undefined || raw === null) continue;
    const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
    if (!Number.isFinite(ms)) throw ruleError('invalid_schedule_time', "Invalid '" + key + "' anchor for interval rule");
    return ms;
  }
  return null;
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw ruleError('invalid_weekdays', 'weekly rules require a non-empty weekdays array (ISO 1=Mon .. 7=Sun)');
  }
  const unique = new Set();
  for (const day of value) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw ruleError('invalid_weekdays', 'weekdays must be integers between 1 (Mon) and 7 (Sun)');
    }
    unique.add(day);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

// ─── Per-kind normalization ─────────────────────────────────────────────────

function normalizeOnce(rule) {
  const raw = rule.at;
  if (typeof raw !== 'string' || !ISO_WITH_OFFSET_RE.test(raw.trim())) {
    throw ruleError('invalid_schedule_time', "'once' requires 'at' as an ISO-8601 timestamp with an explicit UTC offset");
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw ruleError('invalid_schedule_time', "'once' requires a valid ISO-8601 'at' timestamp");
  }
  return { kind: 'once', at: new Date(ms).toISOString(), atMs: ms };
}

function normalizeInterval(rule) {
  const everySeconds = rule.everySeconds;
  if (typeof everySeconds !== 'number' || !Number.isInteger(everySeconds) || everySeconds < 60) {
    throw ruleError('invalid_interval', 'interval rules require everySeconds as an integer >= 60');
  }
  const normalized = { kind: 'interval', everySeconds };
  const anchorMs = parseAnchor(rule);
  if (anchorMs !== null) normalized.anchorMs = anchorMs;
  return normalized;
}

function normalizeClockRule(rule, kind) {
  if (!isValidTimeZone(rule.timeZone)) {
    throw ruleError('invalid_time_zone', 'Invalid IANA time zone: ' + String(rule.timeZone));
  }
  let time = parseTimeOfDay(rule.time);
  if (!time && Number.isInteger(rule.hour) && Number.isInteger(rule.minute)) {
    time = { hour: rule.hour, minute: rule.minute, second: Number.isInteger(rule.second) ? rule.second : 0 };
    if (time.hour > 23 || time.minute > 59 || time.second > 59) time = null;
  }
  if (!time) {
    throw ruleError('invalid_schedule_time', kind + " rules require 'time' as 'HH:mm' or 'HH:mm:ss'");
  }
  const normalized = {
    kind,
    time: formatTimeOfDay(time),
    timeZone: rule.timeZone,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
  if (kind === 'weekly') normalized.weekdays = normalizeWeekdays(rule.weekdays);
  return normalized;
}

function parseCronField(text, spec) {
  const values = new Set();
  for (const rawItem of text.split(',')) {
    const item = rawItem.trim();
    if (item === '') throw ruleError('invalid_cron', 'Invalid cron ' + spec.name + ' field: empty list item');

    let body = item;
    let step = 1;
    const slash = body.indexOf('/');
    if (slash !== -1) {
      const stepText = body.slice(slash + 1);
      body = body.slice(0, slash);
      if (!/^\d+$/.test(stepText)) throw ruleError('invalid_cron', 'Invalid cron step in ' + spec.name + " field: '" + item + "'");
      step = Number(stepText);
      if (step < 1) throw ruleError('invalid_cron', 'Invalid cron step in ' + spec.name + " field: '" + item + "'");
    }

    let lo;
    let hi;
    if (body === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (/^\d+$/.test(body)) {
      lo = Number(body);
      hi = slash === -1 ? lo : spec.max; // Vixie shorthand: a/n == a-max/n
    } else if (/^\d+-\d+$/.test(body)) {
      const dash = body.indexOf('-');
      lo = Number(body.slice(0, dash));
      hi = Number(body.slice(dash + 1));
    } else {
      throw ruleError('invalid_cron', 'Invalid cron ' + spec.name + " field: '" + item + "'");
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw ruleError('invalid_cron', 'Cron ' + spec.name + ' value out of range: ' + spec.min + '-' + spec.max);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (values.size === 0) throw ruleError('invalid_cron', 'Empty cron ' + spec.name + ' field');
  return Array.from(values).sort((a, b) => a - b);
}

function normalizeCron(rule) {
  if (!isValidTimeZone(rule.timeZone)) {
    throw ruleError('invalid_time_zone', 'Invalid IANA time zone: ' + String(rule.timeZone));
  }
  if (typeof rule.expression !== 'string') {
    throw ruleError('invalid_cron', "cron rules require a 5-field 'expression'");
  }
  const expression = rule.expression.trim().replace(/\s+/g, ' ');
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw ruleError('invalid_cron', 'Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)');
  }
  const fields = {};
  parts.forEach((part, index) => {
    fields[CRON_FIELDS[index].name] = parseCronField(part, CRON_FIELDS[index]);
  });
  // Cron day-of-week: 0 and 7 both mean Sunday; store 0..6.
  fields.dayOfWeek = Array.from(new Set(fields.dayOfWeek.map((value) => (value === 7 ? 0 : value)))).sort((a, b) => a - b);
  return {
    kind: 'cron',
    expression,
    timeZone: rule.timeZone,
    fields,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Validate and canonicalize a rule. Throws an Error carrying .code when invalid.
export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw ruleError('invalid_rule', 'Rule must be an object');
  }
  switch (rule.kind) {
    case 'once':
      return normalizeOnce(rule);
    case 'interval':
      return normalizeInterval(rule);
    case 'daily':
      return normalizeClockRule(rule, 'daily');
    case 'weekly':
      return normalizeClockRule(rule, 'weekly');
    case 'cron':
      return normalizeCron(rule);
    default:
      throw ruleError('invalid_rule', 'Unknown rule kind: ' + String(rule.kind));
  }
}

// Never throws. Returns { ok: true, rule } or { ok: false, code, message }.
export function validateRule(input) {
  try {
    const rule = normalizeRule(input);
    if (rule.kind === 'once' && rule.atMs <= Date.now()) {
      return { ok: false, code: 'invalid_schedule_time', message: "'once' time must be strictly in the future" };
    }
    return { ok: true, rule };
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'invalid_rule';
    return { ok: false, code, message: err && err.message ? err.message : 'Invalid rule' };
  }
}

function nextOnce(rule, fromMs) {
  return rule.atMs > fromMs ? rule.atMs : null;
}

function nextInterval(rule, fromMs) {
  const every = rule.everySeconds * 1000;
  const anchor = typeof rule.anchorMs === 'number' ? rule.anchorMs : null;
  if (anchor === null) return fromMs + every;
  if (fromMs < anchor) return anchor;
  return anchor + (Math.floor((fromMs - anchor) / every) + 1) * every;
}

function nextDaily(rule, fromMs) {
  const start = wallParts(rule.timeZone, fromMs);
  for (let i = 0; i <= 14; i += 1) {
    const day = addDays(start.year, start.month, start.day, i);
    const candidate = wallToUtc(rule.timeZone, { ...day, hour: rule.hour, minute: rule.minute, second: rule.second });
    if (candidate !== null && candidate > fromMs) return candidate;
  }
  return null;
}

function nextWeekly(rule, fromMs) {
  const start = wallParts(rule.timeZone, fromMs);
  for (let i = 0; i <= 21; i += 1) {
    const day = addDays(start.year, start.month, start.day, i);
    if (!rule.weekdays.includes(isoWeekday(day.year, day.month, day.day))) continue;
    const candidate = wallToUtc(rule.timeZone, { ...day, hour: rule.hour, minute: rule.minute, second: rule.second });
    if (candidate !== null && candidate > fromMs) return candidate;
  }
  return null;
}

function nextCron(rule, fromMs) {
  const { fields, timeZone, domRestricted, dowRestricted } = rule;
  const start = wallParts(timeZone, fromMs);
  for (let i = 0; i <= MAX_DAY_SCAN; i += 1) {
    const day = addDays(start.year, start.month, start.day, i);
    if (!fields.month.includes(day.month)) continue;

    const domMatch = fields.dayOfMonth.includes(day.day);
    const dow = isoWeekday(day.year, day.month, day.day) % 7; // cron 0=Sun
    const dowMatch = fields.dayOfWeek.includes(dow);
    // Vixie: when both day fields are restricted, either one may match.
    const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) continue;

    for (const hour of fields.hour) {
      for (const minute of fields.minute) {
        const candidate = wallToUtc(timeZone, { ...day, hour, minute, second: 0 });
        if (candidate !== null && candidate > fromMs) return candidate;
      }
    }
  }
  return null;
}

// Next epoch-ms instant strictly after fromMs, or null when the rule is
// exhausted (one-shot in the past, or a cron that can never match again).
export function computeNextRun(rule, fromMs = Date.now()) {
  const normalized = normalizeRule(rule);
  const from = Number.isFinite(fromMs) ? fromMs : Date.now();
  switch (normalized.kind) {
    case 'once':
      return nextOnce(normalized, from);
    case 'interval':
      return nextInterval(normalized, from);
    case 'daily':
      return nextDaily(normalized, from);
    case 'weekly':
      return nextWeekly(normalized, from);
    case 'cron':
      return nextCron(normalized, from);
    default:
      return null;
  }
}

function formatInterval(seconds) {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? '1 hour' : hours + ' hours';
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1 minute' : minutes + ' minutes';
  }
  return seconds + ' seconds';
}

// Short English summary for the UI, e.g. "Every 5 minutes", "Daily at 09:30 (UTC)".
export function describeRule(rule) {
  const normalized = normalizeRule(rule);
  switch (normalized.kind) {
    case 'once':
      return 'Once at ' + normalized.at;
    case 'interval':
      return 'Every ' + formatInterval(normalized.everySeconds);
    case 'daily':
      return 'Daily at ' + formatTimeOfDay(normalized) + ' (' + normalized.timeZone + ')';
    case 'weekly':
      return (
        'Weekly on ' +
        normalized.weekdays.map((day) => ISO_WEEKDAY_SHORT[day]).join(', ') +
        ' at ' +
        formatTimeOfDay(normalized) +
        ' (' +
        normalized.timeZone +
        ')'
      );
    case 'cron':
      return 'Cron "' + normalized.expression + '" (' + normalized.timeZone + ')';
    default:
      return '';
  }
}
