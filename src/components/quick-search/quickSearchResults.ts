type Timestamped = {
  timestamp?: string | null;
};

export function containsAllWords(target: string, words: string[]): boolean {
  const normalizedTarget = target.toLowerCase();
  return words.every((word) => normalizedTarget.includes(word.toLowerCase()));
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function newestMatch<T extends Timestamped>(matches: T[]): T | undefined {
  return matches.reduce<T | undefined>((newest, match) => {
    if (!newest || timestampValue(match.timestamp) > timestampValue(newest.timestamp)) {
      return match;
    }
    return newest;
  }, undefined);
}

export function sortByTimestampDescending<T extends Timestamped>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftTimestamp = timestampValue(left.timestamp);
    const rightTimestamp = timestampValue(right.timestamp);
    if (leftTimestamp === rightTimestamp) return 0;
    return rightTimestamp > leftTimestamp ? 1 : -1;
  });
}
