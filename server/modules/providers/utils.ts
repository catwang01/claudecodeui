import { stat, readdir, createReadStream } from 'fs';
import { promisify } from 'util';
import path from 'path';
import readline from 'readline';

const statAsync = promisify(stat);
const readdirAsync = promisify(readdir);

export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt: string; updatedAt: string }> {
  const s = await statAsync(filePath);
  return {
    createdAt: s.birthtime.toISOString(),
    updatedAt: s.mtime.toISOString(),
  };
}

export async function readFirstJsonlLine<T>(
  filePath: string,
  parse: (data: unknown) => T | null
): Promise<T | null> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parse(JSON.parse(trimmed));
        if (parsed !== null) {
          rl.close();
          fileStream.destroy();
          return parsed;
        }
      } catch {
        /* skip malformed JSON */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    fileStream.destroy();
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
      entries = await readdirAsync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const s = await statAsync(fullPath);
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
