// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchesExcludePattern } from '../excludePatterns';

describe('matchesExcludePattern (shared contract)', () => {
  it('matches an anchored pattern against the directory name', () => {
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', ['^agent.*'])).toBe(true);
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', ['^agent-xx$'])).toBe(true);
  });

  it('does not match a sibling directory for an anchored pattern', () => {
    expect(matchesExcludePattern('/Users/x/MyFolder/normal', ['^agent.*'])).toBe(false);
  });

  it('keeps full-path substring and suffix matching working', () => {
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', ['agent-xx'])).toBe(true);
    expect(matchesExcludePattern('/Users/x/MyFolder/old-archive', ['.*-archive$'])).toBe(true);
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx/', ['.*-archive$'])).toBe(false);
  });

  it('ignores trailing separators when deriving the directory name', () => {
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx/', ['^agent-xx$'])).toBe(true);
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx///', ['^agent-xx$'])).toBe(true);
  });

  it('handles bare names and Windows/UNC paths', () => {
    expect(matchesExcludePattern('agent-xx', ['^agent-xx$'])).toBe(true);
    expect(matchesExcludePattern(String.raw`C:\work\agent-01`, ['^agent.*'])).toBe(true);
    expect(matchesExcludePattern(String.raw`\\server\share\agent-01`, ['^agent.*'])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(matchesExcludePattern('/Users/x/MyFolder/AGENT-XX', ['^agent.*'])).toBe(true);
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', ['^AGENT.*'])).toBe(true);
  });

  it('ignores invalid and blank patterns without throwing', () => {
    const cases = [['['], ['(unclosed'], [''], ['   '], ['['], []];
    for (const patterns of cases) {
      expect(() => matchesExcludePattern('/Users/x/MyFolder/agent-xx', patterns)).not.toThrow();
      expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', patterns)).toBe(false);
    }
  });

  it('is defensive about non-array patterns and non-string entries', () => {
    for (const patterns of [undefined, null, '^agent.*', 42, {}]) {
      expect(() => matchesExcludePattern('/Users/x/MyFolder/agent-xx', patterns)).not.toThrow();
      expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', patterns)).toBe(false);
    }
    expect(matchesExcludePattern('/Users/x/MyFolder/agent-xx', [null, 7, {}, '^agent.*'])).toBe(true);
  });

  it('does not throw on a non-string target', () => {
    expect(() => matchesExcludePattern(undefined, ['^agent.*'])).not.toThrow();
    expect(matchesExcludePattern(undefined, ['^agent.*'])).toBe(false);
  });

  it('does not treat an empty basename as a match for ^$', () => {
    expect(matchesExcludePattern('/', ['^$'])).toBe(false);
    expect(matchesExcludePattern('///', ['^$'])).toBe(false);
  });
});
