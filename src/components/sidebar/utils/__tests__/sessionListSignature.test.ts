import { describe, expect, it } from 'vitest';
import type { Project, ProjectSession } from '../../../../types/app';
import { buildSessionListSignature } from '../sessionListSignature';

const project = (name: string): Project => ({ name, displayName: name, fullPath: `/tmp/${name}` });

const session = (id: string, __provider: ProjectSession['__provider'] = 'claude', lastActivity = '2026-01-01T00:00:00Z'): ProjectSession => ({
  id,
  lastActivity,
  __provider,
});

function signatureOf(projects: Project[], sessionsByProject: Record<string, ProjectSession[]>): string {
  return buildSessionListSignature(projects, (p) => sessionsByProject[p.name] ?? []);
}

describe('buildSessionListSignature', () => {
  it('is stable when only mutable session fields change', () => {
    const projects = [project('a')];
    const before = signatureOf(projects, { a: [session('s1', 'claude', '2026-01-01T00:00:00Z')] });
    const after = signatureOf(projects, { a: [{ ...session('s1'), lastActivity: '2026-02-02T00:00:00Z', messageCount: 99 }] });

    expect(after).toBe(before);
  });

  it('is independent of the order projects/sessions are returned in', () => {
    const a = signatureOf([project('a'), project('b')], {
      a: [session('s1'), session('s2')],
      b: [session('s3')],
    });
    const b = signatureOf([project('b'), project('a')], {
      a: [session('s2'), session('s1')],
      b: [session('s3')],
    });

    expect(b).toBe(a);
  });

  it('changes when a session is added', () => {
    const projects = [project('a')];
    const before = signatureOf(projects, { a: [session('s1')] });
    const after = signatureOf(projects, { a: [session('s1'), session('fresh-fork')] });

    expect(after).not.toBe(before);
  });

  it('changes when a session is removed', () => {
    const projects = [project('a')];
    const before = signatureOf(projects, { a: [session('s1'), session('s2')] });
    const after = signatureOf(projects, { a: [session('s1')] });

    expect(after).not.toBe(before);
  });

  it('keeps the same id from different providers distinct', () => {
    const projects = [project('a')];
    const claude = signatureOf(projects, { a: [session('shared', 'claude')] });
    const copilot = signatureOf(projects, { a: [session('shared', 'copilot')] });

    expect(copilot).not.toBe(claude);
  });
});
