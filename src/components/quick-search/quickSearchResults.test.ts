import { describe, expect, it } from 'vitest';
import { containsAllWords, newestMatch, sortByTimestampDescending } from './quickSearchResults';

describe('quick search project matching', () => {
  it('does not match query letters scattered across a project path', () => {
    const path = String.raw`C:\Users\zhenwang\source\Repos\skill-collections`;

    expect(containsAllWords(path, ['hello'])).toBe(false);
  });

  it('matches contiguous query words in a project path', () => {
    const path = String.raw`C:\Users\zhenwang\source\Repos\hello-world`;

    expect(containsAllWords(path, ['hello', 'world'])).toBe(true);
  });
});

describe('quick search result ordering', () => {
  it('sorts timestamped results newest first and leaves missing timestamps last', () => {
    const results = sortByTimestampDescending([
      { id: 'older', timestamp: '2026-08-05T10:00:00.000Z' },
      { id: 'missing', timestamp: null },
      { id: 'newer', timestamp: '2026-08-07T10:00:00.000Z' },
    ]);

    expect(results.map((result) => result.id)).toEqual(['newer', 'older', 'missing']);
  });

  it('selects the newest match from a session', () => {
    const match = newestMatch([
      { snippet: 'old', timestamp: '2026-08-05T10:00:00.000Z' },
      { snippet: 'new', timestamp: '2026-08-07T10:00:00.000Z' },
    ]);

    expect(match?.snippet).toBe('new');
  });
});
