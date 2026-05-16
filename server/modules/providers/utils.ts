import { open, stat, readdir } from 'fs/promises';
import path from 'path';

export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt: string; updatedAt: string }> {
  const s = await stat(filePath);
  return {
    createdAt: s.birthtime.toISOString(),
    updatedAt: s.mtime.toISOString(),
  };
}

export async function readFirstJsonlLine<T>(
  filePath: string,
  parse: (data: unknown) => T | null
): Promise<T | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parse(JSON.parse(trimmed));
        if (parsed !== null) return parsed;
      } catch { /* skip malformed */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function findFilesModifiedAfter(
  rootDir: string,
  ext: string,
  since: Date | null
): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath);
        } else if (entry.endsWith(ext)) {
          if (!since || s.mtime > since) {
            result.push(fullPath);
          }
        }
      } catch { /* skip inaccessible */ }
    }
  }

  await walk(rootDir);
  return result;
}
