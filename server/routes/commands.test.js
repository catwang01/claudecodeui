import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';

import { isPathUnderBase } from './commands.js';

const home = os.homedir();
const userBase = path.join(home, '.claude', 'commands');
const projectBase = path.join(home, 'projects', 'demo', '.claude', 'commands');

describe('isPathUnderBase', () => {
  it('accepts files inside the user-level commands dir', () => {
    expect(isPathUnderBase(userBase, path.join(userBase, 'review.md'))).toBe(true);
    expect(isPathUnderBase(userBase, path.join(userBase, 'nested', 'deep.md'))).toBe(true);
  });

  it('accepts files inside the project-level commands dir', () => {
    expect(isPathUnderBase(projectBase, path.join(projectBase, 'deploy.md'))).toBe(true);
  });

  it('rejects the base directory itself', () => {
    expect(isPathUnderBase(userBase, userBase)).toBe(false);
  });

  it('rejects sibling dirs sharing a string prefix', () => {
    // e.g. /Users/edward/.claude/commands vs /Users/edward/.claude/commands-evil
    expect(isPathUnderBase(userBase, `${userBase}-evil/x.md`)).toBe(false);
  });

  it('rejects unrelated absolute paths', () => {
    expect(isPathUnderBase(userBase, '/etc/passwd')).toBe(false);
  });

  it('rejects paths that merely contain the substring .claude/commands', () => {
    // The old implementation used `includes('.claude/commands')`, which accepted this.
    expect(
      isPathUnderBase(userBase, path.join(home, 'tmp', '.claude', 'commands', 'x.md')),
    ).toBe(false);
  });

  it('rejects parent traversal', () => {
    expect(isPathUnderBase(userBase, path.join(userBase, '..', 'secret.md'))).toBe(false);
  });
});
