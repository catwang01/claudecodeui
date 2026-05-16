import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFirstJsonlLine, findFilesModifiedAfter, readFileTimestamps } from '../utils.js';

describe('readFirstJsonlLine', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts sessionId and cwd from first valid line', async () => {
    const filePath = join(tmpDir, 'session.jsonl');
    await writeFile(filePath, '{"sessionId":"abc-123","cwd":"/home/user/project","type":"user"}\n{"type":"assistant"}\n');

    const result = await readFirstJsonlLine(filePath, (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string') return null;
      return { sessionId: d.sessionId, projectPath: d.cwd as string };
    });

    expect(result).toEqual({ sessionId: 'abc-123', projectPath: '/home/user/project' });
  });

  it('returns null for empty file', async () => {
    const filePath = join(tmpDir, 'empty.jsonl');
    await writeFile(filePath, '');
    const result = await readFirstJsonlLine(filePath, () => null);
    expect(result).toBeNull();
  });

  it('returns null if parse fn returns null', async () => {
    const filePath = join(tmpDir, 'no-match.jsonl');
    await writeFile(filePath, '{"type":"unknown"}\n');
    const result = await readFirstJsonlLine(filePath, () => null);
    expect(result).toBeNull();
  });
});

describe('findFilesModifiedAfter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds all .jsonl files when since is null', async () => {
    await writeFile(join(tmpDir, 'a.jsonl'), '');
    await writeFile(join(tmpDir, 'b.jsonl'), '');
    await writeFile(join(tmpDir, 'c.txt'), '');

    const files = await findFilesModifiedAfter(tmpDir, '.jsonl', null);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith('.jsonl'))).toBe(true);
  });

  it('filters by modification time when since is provided', async () => {
    const past = new Date(Date.now() + 5000); // future date
    await writeFile(join(tmpDir, 'old.jsonl'), '');

    const files = await findFilesModifiedAfter(tmpDir, '.jsonl', past);
    expect(files).toHaveLength(0);
  });
});

describe('readFileTimestamps', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ISO timestamp strings', async () => {
    const filePath = join(tmpDir, 'test.jsonl');
    await writeFile(filePath, 'hello');

    const ts = await readFileTimestamps(filePath);
    expect(ts.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ts.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
