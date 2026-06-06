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

  // Register 'close' listener immediately — before any I/O — so we never miss the event.
  // Awaiting this Promise in the finally block ensures the fd is actually closed before
  // we return. Without this, sequential callers (e.g. synchronize() scanning thousands
  // of files) accumulate pending-close fds (fileStream.destroy() is libuv-async),
  // causing posix_spawn EBADF when the fd table fills up.
  let streamClosed = false;
  const closedPromise = new Promise<void>(resolve => {
    fileStream.once('close', () => { streamClosed = true; resolve(); });
  });

  let result: T | null = null;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parse(JSON.parse(trimmed));
        if (parsed !== null) {
          result = parsed;
          break; // exit loop; finally handles cleanup + awaits close
        }
      } catch {
        /* skip malformed JSON */
      }
    }
  } catch {
    /* ignore read errors */
  } finally {
    rl.close();
    fileStream.destroy();
    // Await actual fd close only if it hasn't happened yet (fast-path for natural EOF reads).
    if (!streamClosed) {
      await closedPromise;
    }
  }

  return result;
}

export async function findFilesModifiedAfter(
  rootDir: string,
  ext: string,
  since: Date | null,
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
