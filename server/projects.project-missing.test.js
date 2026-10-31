// @vitest-environment node
/**
 * Issue #16 regression tests: project directory availability + sticky archive +
 * legacy-fallback resurrection guard + realpath alias handling (verifier F1/F2).
 *
 * DATABASE_PATH and HOME are pointed at a throwaway directory *before* the modules under test
 * are dynamically imported, so none of these tests can touch the real app DB or ~/.claude.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-project-missing-'));
const HOME_DIR = path.join(TMP, 'home');
const LEGACY_PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.HOME = HOME_DIR;

// Keep the test DB hermetic: the connection bootstrap copies server/database/auth.db into a
// non-existent DATABASE_PATH. Pre-creating an empty SQLite file skips that stale copy.
fs.writeFileSync(process.env.DATABASE_PATH, '');

// macOS exposes os.tmpdir() as /var/... while its realpath is /private/var/... — exactly the
// alias pair the verifier used. On filesystems without that alias these tests are skipped.
const REAL_TMP = fs.realpathSync(TMP);
const TMP_HAS_SYMLINK_ALIAS = REAL_TMP !== TMP;

// macOS APFS is case-insensitive by default; canonicalization must collapse `Foo`/`foo`.
const FS_CASE_INSENSITIVE = (() => {
  try {
    return fs.realpathSync.native(TMP.toUpperCase()) === REAL_TMP;
  } catch {
    return false;
  }
})();

let getProjectPathAvailability;
let getProjects;
let archiveProjectsUnderPath;
let archiveProjectByName;
let canonicalizeProjectPath;
let isPathSameOrInside;
let projectsDb;
let closeConnection;

const mk = (name) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const encodeProjectName = (projectPath) => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

/** Writes the kind of ~/.claude/projects/<encoded>/<session>.jsonl the legacy scan reads. */
function writeLegacyProbe(sessionId, projectPath) {
  const dir = path.join(LEGACY_PROJECTS_DIR, encodeProjectName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
    sessionId,
    cwd: projectPath,
    type: 'user',
    uuid: sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'probe' },
  })}\n`, 'utf8');
}

beforeAll(async () => {
  fs.mkdirSync(LEGACY_PROJECTS_DIR, { recursive: true });
  const projects = await import('./projects.js');
  getProjectPathAvailability = projects.getProjectPathAvailability;
  getProjects = projects.getProjects;
  archiveProjectsUnderPath = projects.archiveProjectsUnderPath;
  archiveProjectByName = projects.archiveProjectByName;
  ({ projectsDb, canonicalizeProjectPath, isPathSameOrInside } = await import('./modules/database/index.js'));
  ({ closeConnection } = await import('./modules/database/connection.js'));
});

afterAll(() => {
  try {
    closeConnection();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('getProjectPathAvailability', () => {
  it('reports an existing directory as available and readable', async () => {
    const dir = mk('exists');
    await expect(getProjectPathAvailability(dir)).resolves.toEqual({
      status: 'available',
      available: true,
      readable: true,
      reason: null,
      errorCode: null,
    });
  });

  it('reports ENOENT as missing / not_found', async () => {
    const result = await getProjectPathAvailability(path.join(TMP, 'deleted-dir'));
    expect(result).toMatchObject({
      status: 'missing',
      available: false,
      readable: false,
      reason: 'not_found',
      errorCode: 'ENOENT',
    });
  });

  it('reports ENOTDIR (a path component is a file) as missing / not_a_directory', async () => {
    const file = path.join(TMP, 'plain-file');
    fs.writeFileSync(file, 'x');
    const result = await getProjectPathAvailability(path.join(file, 'child'));
    expect(result).toMatchObject({
      status: 'missing',
      available: false,
      reason: 'not_a_directory',
      errorCode: 'ENOTDIR',
    });
  });

  it('reports a regular file path as missing / not_a_directory', async () => {
    const file = path.join(TMP, 'plain-file-2');
    fs.writeFileSync(file, 'x');
    const result = await getProjectPathAvailability(file);
    expect(result).toMatchObject({ status: 'missing', available: false, reason: 'not_a_directory' });
  });

  it('reports an empty path as missing / empty_path', async () => {
    await expect(getProjectPathAvailability('')).resolves.toMatchObject({
      status: 'missing',
      available: false,
      reason: 'empty_path',
    });
  });

  it('never treats EACCES as missing: the project stays available with a reason', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return; // root bypasses permission bits
    }
    const parent = mk('locked-parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    fs.chmodSync(parent, 0o000);
    try {
      const result = await getProjectPathAvailability(child);
      expect(result).toMatchObject({
        status: 'available',
        available: true,
        readable: false,
        reason: 'permission_denied',
      });
      expect(result.errorCode).toBe('EACCES');
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });
});

describe('sticky archive (issue #16)', () => {
  it('does not resurrect an archived project when the synchronizer re-registers the path', async () => {
    const dir = mk('sticky-project');
    expect(projectsDb.createProjectPath(dir).outcome).toBe('created');
    expect(projectsDb.archiveProject(dir)).toBe(1);
    expect(projectsDb.getAllProjects().some((p) => p.project_path === dir)).toBe(false);

    // This is the exact call every session synchronizer makes for each newly scanned .jsonl.
    const resync = projectsDb.createProjectPath(dir);
    expect(resync.outcome).toBe('archived_conflict');
    expect(resync.project?.isArchived).toBe(1);
    expect(projectsDb.getAllProjects().some((p) => p.project_path === dir)).toBe(false);
  });

  it('reactivates an archived row only on an explicit user re-add', async () => {
    const dir = mk('reactivate-project');
    projectsDb.createProjectPath(dir);
    projectsDb.archiveProject(dir);

    const result = projectsDb.createProjectPath(dir, null, { reactivateArchived: true });
    expect(result.outcome).toBe('reactivated_archived');
    expect(result.project?.isArchived).toBe(0);
    expect(projectsDb.getAllProjects().some((p) => p.project_path === dir)).toBe(true);
  });

  it('archiveProject is idempotent', async () => {
    const dir = mk('idempotent-project');
    projectsDb.createProjectPath(dir);
    expect(projectsDb.archiveProject(dir)).toBe(1);
    expect(projectsDb.archiveProject(dir)).toBe(0);
  });
});

describe('archiveProjectsUnderPath', () => {
  it('archives the deleted directory and everything below it, but not siblings', async () => {
    const root = mk('tree');
    const child = path.join(root, 'child');
    const deeper = path.join(child, 'deeper');
    fs.mkdirSync(deeper, { recursive: true });
    const sibling = mk('tree-sibling');
    for (const candidate of [root, child, deeper, sibling]) projectsDb.createProjectPath(candidate);

    const archived = archiveProjectsUnderPath(root).sort();
    expect(archived).toEqual([root, child, deeper].sort());

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(root);
    expect(active).not.toContain(child);
    expect(active).not.toContain(deeper);
    expect(active).toContain(sibling);
  });

  it('matches whole path segments, never a shared string prefix', async () => {
    const parent = mk('prefix');
    const sibling = mk('prefix-sibling');
    projectsDb.createProjectPath(parent);
    projectsDb.createProjectPath(sibling);

    const archived = archiveProjectsUnderPath(parent);
    expect(archived).toContain(parent);
    expect(archived).not.toContain(sibling);
    expect(projectsDb.getAllProjects().map((p) => p.project_path)).toContain(sibling);
  });

  it('still archives when the deleted directory no longer exists on disk', async () => {
    // The file-tree DELETE route removes the directory first and only then archives, so
    // archiveProjectsUnderPath() must canonicalize a path whose realpathSync() fails.
    const dir = path.join(TMP, 'vanished-after-delete');
    projectsDb.createProjectPath(dir);
    fs.rmSync(dir, { recursive: true, force: true }); // never created — still nonexistent

    const archived = archiveProjectsUnderPath(dir);
    expect(archived).toContain(dir);
    expect(projectsDb.getAllProjects().map((p) => p.project_path)).not.toContain(dir);
  });
});

describe('canonicalizeProjectPath / isPathSameOrInside (verifier path edges)', () => {
  it('normalizes trailing slashes and redundant segments', () => {
    const dir = mk('canon-slash');
    expect(canonicalizeProjectPath(dir + path.sep)).toBe(canonicalizeProjectPath(dir));
    expect(canonicalizeProjectPath(path.join(dir, 'nested', '..'))).toBe(canonicalizeProjectPath(dir));
  });

  it('resolves a symlink to the same canonical path as its target', () => {
    const target = mk('canon-link-target');
    const link = path.join(TMP, 'canon-link');
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
    expect(canonicalizeProjectPath(link)).toBe(canonicalizeProjectPath(target));
  });

  it('canonicalizes a missing directory without throwing', () => {
    const ghost = path.join(TMP, 'canon-ghost', 'deeper');
    const canonical = canonicalizeProjectPath(ghost);
    expect(path.isAbsolute(canonical)).toBe(true);
    expect(canonical.endsWith(path.join('canon-ghost', 'deeper'))).toBe(true);
  });

  it('matches whole path segments via isPathSameOrInside', () => {
    const root = path.join(path.sep, 'a', 'b');
    expect(isPathSameOrInside(root, root)).toBe(true);
    expect(isPathSameOrInside(path.join(root, 'c'), root)).toBe(true);
    expect(isPathSameOrInside(path.join(path.sep, 'a', 'bc'), root)).toBe(false);
    expect(isPathSameOrInside('', root)).toBe(false);
    expect(isPathSameOrInside(root, '')).toBe(false);
  });

  it.runIf(FS_CASE_INSENSITIVE)('collapses case differences on a case-insensitive filesystem', () => {
    const dir = mk('canon-case');
    expect(canonicalizeProjectPath(dir.toUpperCase())).toBe(canonicalizeProjectPath(dir));
  });
});

describe.runIf(TMP_HAS_SYMLINK_ALIAS)('realpath aliases (/var vs /private/var)', () => {
  const aliasPath = (relative) => path.join(TMP, relative);
  const realPath = (relative) => path.join(REAL_TMP, relative);

  it('archiveProjectsUnderPath archives every spelling of the deleted directory (verifier F1)', () => {
    const aliasChild = path.join(aliasPath('alias-tree'), 'child');
    const realChild = path.join(realPath('alias-tree'), 'child');
    fs.mkdirSync(aliasChild, { recursive: true });
    projectsDb.createProjectPath(aliasChild);
    projectsDb.createProjectPath(realChild);

    // Delete the directory through the *real* spelling, as the verifier did.
    const archived = archiveProjectsUnderPath(path.join(realPath('alias-tree'), 'child'));
    expect(archived).toEqual(expect.arrayContaining([aliasChild, realChild]));

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(aliasChild);
    expect(active).not.toContain(realChild);
  });

  it('archiveProjectByName archives every alias row and stays idempotent (verifier F2)', async () => {
    const aliasDir = aliasPath('alias-single');
    const realDir = realPath('alias-single');
    fs.mkdirSync(aliasDir, { recursive: true });
    projectsDb.createProjectPath(aliasDir);
    projectsDb.createProjectPath(realDir);

    const first = await archiveProjectByName(encodeProjectName(aliasDir));
    expect(first.found).toBe(true);
    expect(first.archived).toBe(true);
    expect(first.archivedPaths).toEqual(expect.arrayContaining([aliasDir, realDir]));

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(aliasDir);
    expect(active).not.toContain(realDir);

    const second = await archiveProjectByName(encodeProjectName(aliasDir));
    expect(second.found).toBe(true);
    expect(second.archived).toBe(false);
    expect(second.alreadyArchived).toBe(true);
  });

  it('keeps both spellings equal after the directory is deleted (nearest existing ancestor)', () => {
    const aliasDir = aliasPath('alias-deleted');
    const aliasChild = path.join(aliasDir, 'child');
    const realChild = path.join(realPath('alias-deleted'), 'child');
    fs.mkdirSync(aliasChild, { recursive: true });
    projectsDb.createProjectPath(aliasChild);
    projectsDb.createProjectPath(realChild);

    fs.rmSync(aliasChild, { recursive: true, force: true });

    // realpathSync() now fails for both spellings; the fallback must still make them equal.
    expect(canonicalizeProjectPath(aliasChild)).toBe(canonicalizeProjectPath(realChild));

    const archived = archiveProjectsUnderPath(realChild);
    expect(archived).toEqual(expect.arrayContaining([aliasChild, realChild]));
    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(aliasChild);
    expect(active).not.toContain(realChild);
  });

  it.runIf(FS_CASE_INSENSITIVE)('archives case-variant rows on a case-insensitive filesystem', async () => {
    const lower = aliasPath('alias-case');
    const upper = path.join(TMP, 'ALIAS-CASE');
    fs.mkdirSync(lower, { recursive: true });
    projectsDb.createProjectPath(lower);
    projectsDb.createProjectPath(upper);

    const result = await archiveProjectByName(encodeProjectName(lower));
    expect(result.found).toBe(true);
    expect(result.archivedPaths).toEqual(expect.arrayContaining([lower, upper]));

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(lower);
    expect(active).not.toContain(upper);
  });
});

describe('lossy project names must not archive unrelated directories (verifier A4)', () => {
  it('fails closed when x_y and x/y share one encoded name, archiving nothing', async () => {
    const underscoreDir = path.join(TMP, 'name-collision', 'x_y');
    const slashDir = path.join(TMP, 'name-collision', 'x', 'y');
    fs.mkdirSync(underscoreDir, { recursive: true });
    fs.mkdirSync(slashDir, { recursive: true });
    projectsDb.createProjectPath(underscoreDir);
    projectsDb.createProjectPath(slashDir);

    // The API name is lossy: x_y and x/y produce the same encoded string.
    expect(encodeProjectName(underscoreDir)).toBe(encodeProjectName(slashDir));

    const ambiguous = await archiveProjectByName(encodeProjectName(underscoreDir));
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.archived).toBe(false);
    expect(ambiguous.archivedPaths).toEqual([]);
    expect(ambiguous.candidatePaths).toEqual(expect.arrayContaining([underscoreDir, slashDir]));

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).toContain(underscoreDir);
    expect(active).toContain(slashDir);
  });

  it('archives exactly the requested directory when an exact path is supplied (and stays idempotent)', async () => {
    const underscoreDir = path.join(TMP, 'name-collision-2', 'x_y');
    const slashDir = path.join(TMP, 'name-collision-2', 'x', 'y');
    fs.mkdirSync(underscoreDir, { recursive: true });
    fs.mkdirSync(slashDir, { recursive: true });
    projectsDb.createProjectPath(underscoreDir);
    projectsDb.createProjectPath(slashDir);

    const encoded = encodeProjectName(underscoreDir);
    const first = await archiveProjectByName(encoded, { requestedPath: underscoreDir });
    expect(first.ambiguous).toBe(false);
    expect(first.archivedPaths).toContain(underscoreDir);
    expect(first.archivedPaths).not.toContain(slashDir);

    const active = projectsDb.getAllProjects().map((p) => p.project_path);
    expect(active).not.toContain(underscoreDir);
    expect(active).toContain(slashDir);

    const second = await archiveProjectByName(encoded, { requestedPath: underscoreDir });
    expect(second.found).toBe(true);
    expect(second.alreadyArchived).toBe(true);
    expect(second.archivedPaths).toEqual([]);
  });

  it('still expands a single hit (no ambiguity) and archives it', async () => {
    const dir = path.join(TMP, 'single-hit-name');
    fs.mkdirSync(dir, { recursive: true });
    projectsDb.createProjectPath(dir);

    const result = await archiveProjectByName(encodeProjectName(dir));
    expect(result.ambiguous).toBe(false);
    expect(result.archived).toBe(true);
    expect(projectsDb.getAllProjects().map((p) => p.project_path)).not.toContain(dir);
  });
});

describe('legacy fallback must not resurrect archived projects (verifier blocker)', () => {
  it('returns an empty list when every DB row is archived', async () => {
    // Archive everything previous tests left active so getAllProjects() === [].
    for (const row of projectsDb.getAllProjectRows().filter((candidate) => candidate.isArchived === 0)) {
      projectsDb.archiveProject(row.project_path);
    }
    expect(projectsDb.getAllProjects()).toEqual([]);

    // Verifier repro: the directory AND its ~/.claude/projects folder both still exist
    // (archive is non-destructive), so the legacy filesystem scan would list it.
    const archivedDir = mk('legacy-archived');
    projectsDb.createProjectPath(archivedDir);
    projectsDb.archiveProject(archivedDir);
    writeLegacyProbe('legacy-probe-1', archivedDir);

    await expect(getProjects()).resolves.toEqual([]);
  });

  it('lists only the active project once one is registered again', async () => {
    const activeDir = mk('legacy-active');
    projectsDb.createProjectPath(activeDir);

    const projects = await getProjects();
    expect(projects.map((p) => p.path)).toEqual([activeDir]);
  });
});
