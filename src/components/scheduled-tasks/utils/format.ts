/**
 * Locale-aware formatting helpers. No user-visible English lives here: labels
 * come from the Intl APIs or from i18n, so the same code works in any language.
 */

export function formatDateTime(value: string | null | undefined, locale?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString();
  }
}

export function formatTimeOfDay(value: string | null | undefined, locale?: string): string {
  if (!value) return '';
  const parts = value.split(':');
  if (parts.length < 2) return value;
  const date = new Date();
  date.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return value;
  }
}

type RelativeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

const RELATIVE_STEPS: Array<{ unit: RelativeUnit; seconds: number }> = [
  { unit: 'year', seconds: 31536000 },
  { unit: 'month', seconds: 2592000 },
  { unit: 'day', seconds: 86400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
];

/** Locale-aware relative time, e.g. "in 5 minutes" / "3 小时前". */
export function formatRelativeTime(
  value: string | null | undefined,
  locale?: string,
  now: number = Date.now(),
): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diffSeconds = (date.getTime() - now) / 1000;
  const absolute = Math.abs(diffSeconds);
  let unit: RelativeUnit = 'second';
  let amount = Math.round(diffSeconds);

  for (const step of RELATIVE_STEPS) {
    if (absolute >= step.seconds) {
      unit = step.unit;
      amount = Math.round(diffSeconds / step.seconds);
      break;
    }
  }

  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
  } catch {
    return date.toISOString();
  }
}

/**
 * Clock-style duration (H:MM:SS / M:SS). Deliberately language-neutral so no
 * unit strings need translating.
 */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return '';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

export function truncate(value: string | null | undefined, max = 400): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}
