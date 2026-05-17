/**
 * PROJECT DISCOVERY AND MANAGEMENT SYSTEM
 * ========================================
 * 
 * This module manages project discovery for both Claude CLI and Cursor CLI sessions.
 * 
 * ## Architecture Overview
 * 
 * 1. **Claude Projects** (stored in ~/.claude/projects/)
 *    - Each project is a directory named with the project path encoded (/ replaced with -)
 *    - Contains .jsonl files with conversation history including 'cwd' field
 *    - Project metadata stored in ~/.claude/project-config.json
 * 
 * 2. **Cursor Projects** (stored in ~/.cursor/chats/)
 *    - Each project directory is named with MD5 hash of the absolute project path
 *    - Example: /Users/john/myproject -> MD5 -> a1b2c3d4e5f6...
 *    - Contains session directories with SQLite databases (store.db)
 *    - Project path is NOT stored in the database - only in the MD5 hash
 * 
 * ## Project Discovery Strategy
 * 
 * 1. **Claude Projects Discovery**:
 *    - Scan ~/.claude/projects/ directory for Claude project folders
 *    - Extract actual project path from .jsonl files (cwd field)
 *    - Fall back to decoded directory name if no sessions exist
 * 
 * 2. **Cursor Sessions Discovery**:
 *    - For each KNOWN project (from Claude or manually added)
 *    - Compute MD5 hash of the project's absolute path
 *    - Check if ~/.cursor/chats/{md5_hash}/ directory exists
 *    - Read session metadata from SQLite store.db files
 * 
 * 3. **Manual Project Addition**:
 *    - Users can manually add project paths via UI
 *    - Stored in ~/.claude/project-config.json with 'manuallyAdded' flag
 *    - Allows discovering Cursor sessions for projects without Claude sessions
 * 
 * ## Critical Limitations
 * 
 * - **CANNOT discover Cursor-only projects**: From a quick check, there was no mention of
 *   the cwd of each project. if someone has the time, you can try to reverse engineer it.
 * 
 * - **Project relocation breaks history**: If a project directory is moved or renamed,
 *   the MD5 hash changes, making old Cursor sessions inaccessible unless the old
 *   path is known and manually added.
 * 
 * ## Error Handling
 * 
 * - Missing ~/.claude directory is handled gracefully with automatic creation
 * - ENOENT errors are caught and handled without crashing
 * - Empty arrays returned when no projects/sessions exist
 * 
 * ## Caching Strategy
 * 
 * - Project directory extraction is cached to minimize file I/O
 * - Cache is cleared when project configuration changes
 * - Session data is fetched on-demand, not cached
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { spawn } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';
import sessionManager from './sessionManager.js';
import { applyCustomSessionNames, applyHiddenFromRecents, applyAutoDocFlag, applyLastAutoDocAt, filterHiddenAutoDocSessions, applyReadState, appConfigDb, sessionDb, sessionFileCache } from './database/db.js';
import { projectsDb, sessionsDb } from './modules/database/index.js';
import { claudeSessionSynchronizer } from './modules/providers/list/claude/claude-session-synchronizer.provider.js';

async function getProjectGitBranch(projectPath) {
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: projectPath, shell: false });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)); });
    child.on('error', reject);
  });
  try {
    const branch = await run(['symbolic-ref', '--short', 'HEAD']);
    if (branch) return branch;
  } catch { /* fall through */ }
  try {
    return await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

// Import TaskMaster detection functions
async function detectTaskMasterFolder(projectPath) {
  try {
    const taskMasterPath = path.join(projectPath, '.taskmaster');

    // Check if .taskmaster directory exists
    try {
      const stats = await fs.stat(taskMasterPath);
      if (!stats.isDirectory()) {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster exists but is not a directory'
        };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster directory not found'
        };
      }
      throw error;
    }

    // Check for key TaskMaster files
    const keyFiles = [
      'tasks/tasks.json',
      'config.json'
    ];

    const fileStatus = {};
    let hasEssentialFiles = true;

    for (const file of keyFiles) {
      const filePath = path.join(taskMasterPath, file);
      try {
        await fs.access(filePath);
        fileStatus[file] = true;
      } catch (error) {
        fileStatus[file] = false;
        if (file === 'tasks/tasks.json') {
          hasEssentialFiles = false;
        }
      }
    }

    // Parse tasks.json if it exists for metadata
    let taskMetadata = null;
    if (fileStatus['tasks/tasks.json']) {
      try {
        const tasksPath = path.join(taskMasterPath, 'tasks/tasks.json');
        const tasksContent = await fs.readFile(tasksPath, 'utf8');
        const tasksData = JSON.parse(tasksContent);

        // Handle both tagged and legacy formats
        let tasks = [];
        if (tasksData.tasks) {
          // Legacy format
          tasks = tasksData.tasks;
        } else {
          // Tagged format - get tasks from all tags
          Object.values(tasksData).forEach(tagData => {
            if (tagData.tasks) {
              tasks = tasks.concat(tagData.tasks);
            }
          });
        }

        // Calculate task statistics
        const stats = tasks.reduce((acc, task) => {
          acc.total++;
          acc[task.status] = (acc[task.status] || 0) + 1;

          // Count subtasks
          if (task.subtasks) {
            task.subtasks.forEach(subtask => {
              acc.subtotalTasks++;
              acc.subtasks = acc.subtasks || {};
              acc.subtasks[subtask.status] = (acc.subtasks[subtask.status] || 0) + 1;
            });
          }

          return acc;
        }, {
          total: 0,
          subtotalTasks: 0,
          pending: 0,
          'in-progress': 0,
          done: 0,
          review: 0,
          deferred: 0,
          cancelled: 0,
          subtasks: {}
        });

        taskMetadata = {
          taskCount: stats.total,
          subtaskCount: stats.subtotalTasks,
          completed: stats.done || 0,
          pending: stats.pending || 0,
          inProgress: stats['in-progress'] || 0,
          review: stats.review || 0,
          completionPercentage: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
          lastModified: (await fs.stat(tasksPath)).mtime.toISOString()
        };
      } catch (parseError) {
        console.warn('Failed to parse tasks.json:', parseError.message);
        taskMetadata = { error: 'Failed to parse tasks.json' };
      }
    }

    return {
      hasTaskmaster: true,
      hasEssentialFiles,
      files: fileStatus,
      metadata: taskMetadata,
      path: taskMasterPath
    };

  } catch (error) {
    console.error('Error detecting TaskMaster folder:', error);
    return {
      hasTaskmaster: false,
      reason: `Error checking directory: ${error.message}`
    };
  }
}

// Cache for extracted project directories
const projectDirectoryCache = new Map();

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
}

// Module-level cache for the Codex sessions index.
// buildCodexSessionsIndex() recursively scans and parses all ~/.codex/sessions files,
// which is expensive (can be 10-60s on cold disk). Cache it with a short TTL so
// repeated getProjects() calls (e.g. WebSocket refresh) don't rebuild from scratch.
let _codexIndexCache = null;
let _codexIndexCacheTime = 0;
const CODEX_INDEX_TTL_MS = 30_000; // 30 seconds

async function getCachedCodexIndex() {
  const now = Date.now();
  if (!_codexIndexCache || now - _codexIndexCacheTime > CODEX_INDEX_TTL_MS) {
    _codexIndexCache = await buildCodexSessionsIndex();
    _codexIndexCacheTime = now;
  }
  return _codexIndexCache;
}

function invalidateCodexIndexCache() {
  _codexIndexCache = null;
  _codexIndexCacheTime = 0;
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const configPath = path.join(claudeDir, 'project-config.json');

  // Ensure the .claude directory exists
  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);

    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }

  // Extract the last folder name from the path (works for both Unix and Windows paths)
  const basename = path.basename(projectPath);
  return basename || projectPath;
}

// Read the first cwd value found in a JSONL file, then stop reading.
// Uses a callback-based readline so we can destroy the stream early.
function readFirstCwdFromJsonl(filePath) {
  return new Promise((resolve) => {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let resolved = false;

    function finish(cwd) {
      if (resolved) return;
      resolved = true;
      rl.close();
      fileStream.destroy();
      resolve(cwd);
    }

    rl.on('line', (line) => {
      if (resolved || !line.trim()) return;
      try {
        const entry = JSON.parse(line);
        if (entry.cwd) finish(entry.cwd);
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => finish(null));
    fileStream.on('error', () => finish(null));
  });
}

// Converts an absolute project path to the Claude directory name.
// Matches Claude CLI's aO() function: replace(/[^a-zA-Z0-9]/g, "-")
// e.g. Mac:  /Users/foo/myproject   → -Users-foo-myproject
// e.g. Win:  C:\Users\foo\myproject → C--Users-foo-myproject
function pathToClaudeProjectName(absolutePath) {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }

  // Check DB for manually added projects
  try {
    const dbProjects = projectsDb.getAllProjects();
    const match = dbProjects.find(p => pathToClaudeProjectName(p.project_path) === projectName);
    if (match) {
      projectDirectoryCache.set(projectName, match.project_path);
      return match.project_path;
    }
  } catch { /* DB not ready, ignore */ }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  let extractedPath;

  try {
    // Check if the project directory exists
    await fs.access(projectDir);

    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // Sort files by mtime descending so we read the most recently used session first.
      // cwd is consistent within a project, so the first cwd we find is the right one.
      const fileStats = await Promise.all(
        jsonlFiles.map(async f => ({
          file: f,
          mtime: (await fs.stat(path.join(projectDir, f))).mtimeMs
        }))
      );
      fileStats.sort((a, b) => b.mtime - a.mtime);

      // Fast path: read just enough of each file to find the first cwd, then stop.
      for (const { file } of fileStats) {
        const cwd = await readFirstCwdFromJsonl(path.join(projectDir, file));
        if (cwd) {
          extractedPath = cwd;
          break;
        }
      }

      if (!extractedPath) {
        extractedPath = projectName.replace(/-/g, '/');
      }
    }

    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;

  } catch (error) {
    // If the directory doesn't exist, just use the decoded project name
    if (error.code === 'ENOENT') {
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      console.error(`Error extracting project directory for ${projectName}:`, error);
      // Fall back to decoded project name for other errors
      extractedPath = projectName.replace(/-/g, '/');
    }

    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;
  }
}

// Returns a Set of session IDs that should be excluded from all views:
// auto-doc fork sessions + user-hidden-from-recents sessions.
// Used by both getProjects and searchConversations to keep filtering consistent.
function buildExcludedSessionIds(provider = 'claude') {
  const hideAutoDocRaw = appConfigDb.get('auto_doc_hide_sessions');
  const hideAutoDoc = hideAutoDocRaw === null ? true : hideAutoDocRaw === 'true';
  const autoDocIds = hideAutoDoc ? sessionDb.getAllAutoDocSessionIds(provider) : new Set();
  const hiddenIds = sessionDb.getAllHiddenSessionIds(provider);
  return new Set([...autoDocIds, ...hiddenIds]);
}

async function getProjects(progressCallback = null) {
  const projects = [];
  const codexSessionsIndexRef = { sessionsByProject: null };

  const excludedSessionIds = buildExcludedSessionIds('claude');
  const autoDocPreFilter = excludedSessionIds.size > 0
    ? (sessions) => sessions.filter(s => !excludedSessionIds.has(s.id))
    : null;

  let dbProjects = [];
  try {
    dbProjects = projectsDb.getAllProjects();
  } catch (err) {
    console.warn('[getProjects] Failed to load DB projects:', err.message);
  }

  // If DB is empty (synchronizer hasn't run yet), fall back to filesystem scan
  if (dbProjects.length === 0) {
    return getProjectsLegacy(progressCallback);
  }

  const totalProjects = dbProjects.length;

  for (let i = 0; i < dbProjects.length; i++) {
    const dbProject = dbProjects[i];
    const projectPath = dbProject.project_path;
    const claudeDirName = dbProject.claude_dir_name || pathToClaudeProjectName(projectPath);

    if (progressCallback) {
      progressCallback({
        phase: 'loading',
        current: i + 1,
        total: totalProjects,
        currentProject: path.basename(projectPath),
      });
    }

    const autoDisplayName = await generateDisplayName(claudeDirName, projectPath);

    const project = {
      name: claudeDirName,
      path: projectPath,
      displayName: dbProject.custom_project_name || autoDisplayName,
      fullPath: projectPath,
      isCustomName: !!dbProject.custom_project_name,
      sessions: [],
      geminiSessions: [],
      cursorSessions: [],
      codexSessions: [],
      sessionMeta: { hasMore: false, total: 0 },
    };

    // Claude sessions: query DB index directly, enrich via session_file_cache
    const claudeRows = sessionsDb.getSessionsByProjectPath(projectPath)
      .filter(row => row.provider === 'claude' && row.jsonl_path);
    const claudeSessions = [];
    for (const row of claudeRows) {
      const meta = await getSessionFileMeta(row.jsonl_path).catch(() => null);
      if (!meta?.sessionId) continue;
      const lastActivity = meta.lastActivity ? new Date(meta.lastActivity) : meta.mtime;
      claudeSessions.push({
        id: row.session_id,
        summary: row.custom_name
          || (meta.lastUserMessage
            ? (meta.lastUserMessage.length > 50
              ? meta.lastUserMessage.slice(0, 50) + '...'
              : meta.lastUserMessage)
            : 'New Session'),
        messageCount: meta.messageCount,
        lastActivity,
        cwd: meta.cwd || '',
        lastUserMessage: meta.lastUserMessage,
        lastAssistantMessage: meta.lastAssistantMessage,
      });
    }
    claudeSessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const filteredClaude = autoDocPreFilter ? autoDocPreFilter(claudeSessions) : claudeSessions;
    applyCustomSessionNames(filteredClaude, 'claude');
    applyHiddenFromRecents(filteredClaude, 'claude');
    applyAutoDocFlag(filteredClaude, 'claude');
    applyLastAutoDocAt(filteredClaude, 'claude');
    filterHiddenAutoDocSessions(filteredClaude);
    applyReadState(filteredClaude, 'claude');
    project.sessions = filteredClaude.slice(0, 15);
    project.sessionMeta = {
      hasMore: filteredClaude.length > 15,
      total: sessionsDb.countSessionsByProjectPath(projectPath),
    };

    // Non-Claude providers: keep existing functions
    const [cursorResult, codexResult, geminiResult, taskMasterResult, gitBranchResult] =
      await Promise.allSettled([
        getCursorSessions(projectPath),
        getCodexSessions(projectPath, { indexRef: codexSessionsIndexRef }),
        (async () => {
          const uiSessions = sessionManager.getProjectSessions(projectPath) || [];
          const cliSessions = await getGeminiCliSessions(projectPath);
          const uiIds = new Set(uiSessions.map(s => s.id));
          return [...uiSessions, ...cliSessions.filter(s => !uiIds.has(s.id))];
        })(),
        detectTaskMasterFolder(projectPath),
        getProjectGitBranch(projectPath),
      ]);

    project.cursorSessions = cursorResult.status === 'fulfilled' ? cursorResult.value : [];
    applyCustomSessionNames(project.cursorSessions, 'cursor');
    applyHiddenFromRecents(project.cursorSessions, 'cursor');
    applyReadState(project.cursorSessions, 'cursor');

    project.codexSessions = codexResult.status === 'fulfilled' ? codexResult.value : [];
    applyCustomSessionNames(project.codexSessions, 'codex');
    applyHiddenFromRecents(project.codexSessions, 'codex');
    applyReadState(project.codexSessions, 'codex');

    project.geminiSessions = geminiResult.status === 'fulfilled' ? geminiResult.value : [];
    applyCustomSessionNames(project.geminiSessions, 'gemini');
    applyHiddenFromRecents(project.geminiSessions, 'gemini');
    applyReadState(project.geminiSessions, 'gemini');

    if (taskMasterResult.status === 'fulfilled') {
      const r = taskMasterResult.value;
      project.taskmaster = {
        hasTaskmaster: r.hasTaskmaster,
        hasEssentialFiles: r.hasEssentialFiles,
        metadata: r.metadata,
        status: r.hasTaskmaster && r.hasEssentialFiles ? 'configured' : 'not-configured',
      };
    } else {
      project.taskmaster = { hasTaskmaster: false, hasEssentialFiles: false, metadata: null, status: 'error' };
    }

    project.currentBranch = gitBranchResult.status === 'fulfilled' ? gitBranchResult.value : null;

    projects.push(project);
  }

  if (progressCallback) {
    progressCallback({ phase: 'complete', current: totalProjects, total: totalProjects });
  }

  return projects;
}

async function getProjectsLegacy(progressCallback = null) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projects = [];
  const existingProjects = new Set();
  const codexSessionsIndexRef = { sessionsByProject: null };
  let totalProjects = 0;
  let processedProjects = 0;
  let directories = [];

  const excludedSessionIds = buildExcludedSessionIds('claude');
  const autoDocPreFilter = excludedSessionIds.size > 0
    ? (sessions) => sessions.filter(s => !excludedSessionIds.has(s.id))
    : null;

  const isUUID = (name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);

  let dbProjects = [];
  try { dbProjects = projectsDb.getAllProjects(); } catch { /* ignore */ }

  try {
    await fs.access(claudeDir);
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    directories = entries.filter(e => e.isDirectory() && !isUUID(e.name));
    directories.forEach(e => existingProjects.add(e.name));

    const manualDbCount = dbProjects.filter(p => !existingProjects.has(p.project_path.replace(/[\\/:\s~_]/g, '-'))).length;
    totalProjects = directories.length + manualDbCount;

    for (const entry of directories) {
      processedProjects++;
      if (progressCallback) {
        progressCallback({ phase: 'loading', current: processedProjects, total: totalProjects, currentProject: entry.name });
      }

      const actualProjectDir = await extractProjectDirectory(entry.name);
      const customName = projectsDb.getProjectPath(actualProjectDir)?.custom_project_name || null;
      const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);

      const project = {
        name: entry.name,
        path: actualProjectDir,
        displayName: customName || autoDisplayName,
        fullPath: actualProjectDir,
        isCustomName: !!customName,
        sessions: [],
        geminiSessions: [],
        cursorSessions: [],
        codexSessions: [],
        sessionMeta: { hasMore: false, total: 0 },
      };

      const [sessionResult, cursorSessions, codexSessions, geminiResult, taskMasterResult, gitBranchResult] =
        await Promise.allSettled([
          getSessions(entry.name, 15, 0, autoDocPreFilter),
          getCursorSessions(actualProjectDir),
          getCodexSessions(actualProjectDir, { indexRef: codexSessionsIndexRef }),
          (async () => {
            const uiSessions = sessionManager.getProjectSessions(actualProjectDir) || [];
            const cliSessions = await getGeminiCliSessions(actualProjectDir);
            const uiIds = new Set(uiSessions.map(s => s.id));
            return [...uiSessions, ...cliSessions.filter(s => !uiIds.has(s.id))];
          })(),
          detectTaskMasterFolder(actualProjectDir),
          getProjectGitBranch(actualProjectDir),
        ]);

      if (sessionResult.status === 'fulfilled') {
        project.sessions = sessionResult.value.sessions || [];
        project.sessionMeta = { hasMore: sessionResult.value.hasMore, total: sessionResult.value.total };
      } else {
        console.warn(`Could not load sessions for project ${entry.name}:`, sessionResult.reason?.message);
      }
      applyCustomSessionNames(project.sessions, 'claude');
      applyHiddenFromRecents(project.sessions, 'claude');
      applyAutoDocFlag(project.sessions, 'claude');
      applyLastAutoDocAt(project.sessions, 'claude');
      filterHiddenAutoDocSessions(project.sessions);
      applyReadState(project.sessions, 'claude');

      project.cursorSessions = cursorSessions.status === 'fulfilled' ? cursorSessions.value : [];
      applyCustomSessionNames(project.cursorSessions, 'cursor');
      applyHiddenFromRecents(project.cursorSessions, 'cursor');
      applyReadState(project.cursorSessions, 'cursor');

      project.codexSessions = codexSessions.status === 'fulfilled' ? codexSessions.value : [];
      applyCustomSessionNames(project.codexSessions, 'codex');
      applyHiddenFromRecents(project.codexSessions, 'codex');
      applyReadState(project.codexSessions, 'codex');

      project.geminiSessions = geminiResult.status === 'fulfilled' ? geminiResult.value : [];
      applyCustomSessionNames(project.geminiSessions, 'gemini');
      applyHiddenFromRecents(project.geminiSessions, 'gemini');
      applyReadState(project.geminiSessions, 'gemini');

      if (taskMasterResult.status === 'fulfilled') {
        const r = taskMasterResult.value;
        project.taskmaster = {
          hasTaskmaster: r.hasTaskmaster,
          hasEssentialFiles: r.hasEssentialFiles,
          metadata: r.metadata,
          status: r.hasTaskmaster && r.hasEssentialFiles ? 'configured' : 'not-configured',
        };
      } else {
        project.taskmaster = { hasTaskmaster: false, hasEssentialFiles: false, metadata: null, status: 'error' };
      }

      project.currentBranch = gitBranchResult.status === 'fulfilled' ? gitBranchResult.value : null;

      projects.push(project);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading projects directory:', error);
    }
    totalProjects = dbProjects.filter(p => !existingProjects.has(p.project_path.replace(/[\\/:\s~_]/g, '-'))).length;
  }

  // Load manually-added projects from DB (not already in file system)
  try {
    for (const dbProject of dbProjects) {
      const encodedName = dbProject.project_path.replace(/[\\/:\s~_]/g, '-');
      if (existingProjects.has(encodedName)) continue;

      processedProjects++;
      if (progressCallback) {
        progressCallback({ phase: 'loading', current: processedProjects, total: totalProjects, currentProject: encodedName });
      }

      const actualProjectDir = dbProject.project_path;
      const project = {
        name: encodedName,
        path: actualProjectDir,
        displayName: dbProject.custom_project_name || await generateDisplayName(encodedName, actualProjectDir),
        fullPath: actualProjectDir,
        isCustomName: !!dbProject.custom_project_name,
        isManuallyAdded: true,
        sessions: [],
        geminiSessions: [],
        sessionMeta: { hasMore: false, total: 0 },
        cursorSessions: [],
        codexSessions: [],
      };

      const [cursorSessions, codexSessions, geminiResult, taskMasterResult] =
        await Promise.allSettled([
          getCursorSessions(actualProjectDir),
          getCodexSessions(actualProjectDir, { indexRef: codexSessionsIndexRef }),
          (async () => {
            const uiSessions = sessionManager.getProjectSessions(actualProjectDir) || [];
            const cliSessions = await getGeminiCliSessions(actualProjectDir);
            const uiIds = new Set(uiSessions.map(s => s.id));
            return [...uiSessions, ...cliSessions.filter(s => !uiIds.has(s.id))];
          })(),
          detectTaskMasterFolder(actualProjectDir),
        ]);

      project.cursorSessions = cursorSessions.status === 'fulfilled' ? cursorSessions.value : [];
      applyCustomSessionNames(project.cursorSessions, 'cursor');
      applyHiddenFromRecents(project.cursorSessions, 'cursor');
      applyReadState(project.cursorSessions, 'cursor');

      project.codexSessions = codexSessions.status === 'fulfilled' ? codexSessions.value : [];
      applyCustomSessionNames(project.codexSessions, 'codex');
      applyHiddenFromRecents(project.codexSessions, 'codex');
      applyReadState(project.codexSessions, 'codex');

      project.geminiSessions = geminiResult.status === 'fulfilled' ? geminiResult.value : [];
      applyCustomSessionNames(project.geminiSessions, 'gemini');
      applyHiddenFromRecents(project.geminiSessions, 'gemini');
      applyReadState(project.geminiSessions, 'gemini');

      if (taskMasterResult.status === 'fulfilled') {
        const r = taskMasterResult.value;
        project.taskmaster = { status: r.hasTaskmaster && r.hasEssentialFiles ? 'taskmaster-only' : 'not-configured', hasTaskmaster: r.hasTaskmaster, hasEssentialFiles: r.hasEssentialFiles, metadata: r.metadata };
      } else {
        project.taskmaster = { status: 'error', hasTaskmaster: false, hasEssentialFiles: false };
      }

      projects.push(project);
    }
  } catch (err) {
    console.warn('[projectsDb] Failed to load DB projects:', err.message);
  }

  if (progressCallback) {
    progressCallback({ phase: 'complete', current: totalProjects, total: totalProjects });
  }

  return projects;
}

async function getSessions(projectName, limit = 5, offset = 0, preFilter = null) {
  try {
    const actualProjectDir = await extractProjectDirectory(projectName);
    const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

    // DB-backed: get session rows (index only) sorted by updated_at DESC
    const pageSize = Math.max((limit + offset) * 3, 30);
    let sessionRows = sessionsDb.getSessionsByProjectPathPage(actualProjectDir, pageSize, 0)
      .filter(row => row.provider === 'claude' && row.jsonl_path);

    // Sync-on-miss: if DB is empty, try to sync filesystem and re-query
    if (sessionRows.length === 0) {
      try {
        const files = await fs.readdir(claudeProjectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;
          await claudeSessionSynchronizer.synchronizeFile(path.join(claudeProjectDir, file));
        }
        sessionRows = sessionsDb.getSessionsByProjectPathPage(actualProjectDir, pageSize, 0)
          .filter(row => row.provider === 'claude' && row.jsonl_path);
      } catch { /* directory doesn't exist */ }
    }

    // Legacy fallback: if sync still produced nothing (e.g. JSONL files lack cwd field),
    // fall back to the old filesystem scan for backward compatibility
    if (sessionRows.length === 0) {
      return getSessionsLegacy(projectName, limit, offset, preFilter);
    }

    // Enrich each session with file metadata (via session_file_cache)
    const sessions = [];
    for (const row of sessionRows) {
      const meta = await getSessionFileMeta(row.jsonl_path).catch(() => null);
      if (!meta?.sessionId) continue;

      const lastActivity = meta.lastActivity ? new Date(meta.lastActivity) : meta.mtime;
      sessions.push({
        id: row.session_id,
        summary: row.custom_name
          || (meta.lastUserMessage
            ? (meta.lastUserMessage.length > 50
              ? meta.lastUserMessage.slice(0, 50) + '...'
              : meta.lastUserMessage)
            : 'New Session'),
        messageCount: meta.messageCount,
        lastActivity,
        cwd: meta.cwd || '',
        lastUserMessage: meta.lastUserMessage,
        lastAssistantMessage: meta.lastAssistantMessage,
      });
    }

    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const filteredSessions = preFilter ? preFilter(sessions) : sessions;
    const total = sessionsDb.countSessionsByProjectPath(actualProjectDir);
    const paginatedSessions = filteredSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return { sessions: paginatedSessions, hasMore, total, offset, limit };
  } catch (error) {
    console.error(`Error getting sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function getSessionsLegacy(projectName, limit = 5, offset = 0, preFilter = null) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }

    const filesWithMtime = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, filePath, mtime: stats.mtime };
      })
    );
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    const allSessions = new Map();

    for (const { filePath } of filesWithMtime) {
      const meta = await getSessionFileMeta(filePath);
      if (!meta.sessionId) continue;

      if (!allSessions.has(meta.sessionId)) {
        allSessions.set(meta.sessionId, {
          id: meta.sessionId,
          summary: meta.lastUserMessage
            ? (meta.lastUserMessage.length > 50 ? meta.lastUserMessage.slice(0, 50) + '...' : meta.lastUserMessage)
            : 'New Session',
          messageCount: meta.messageCount,
          lastActivity: meta.lastActivity ? new Date(meta.lastActivity) : meta.mtime,
          cwd: meta.cwd || '',
          lastUserMessage: meta.lastUserMessage,
          lastAssistantMessage: meta.lastAssistantMessage,
        });
      }

      const effectiveCount = preFilter
        ? preFilter(Array.from(allSessions.values())).length
        : allSessions.size;
      if (effectiveCount >= (limit + offset) * 2) break;
    }

    const sessions = Array.from(allSessions.values())
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const filteredSessions = preFilter ? preFilter(sessions) : sessions;
    const total = filteredSessions.length;
    const paginatedSessions = filteredSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return { sessions: paginatedSessions, hasMore, total, offset, limit };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

/**
 * Returns true if a JSONL entry is a subagent-injected user message.
 * Mirrors the frontend logic in useChatMessages.ts:
 *   isSubAgentInput: Boolean(msg.parentToolUseId || msg.isMeta)
 */
function isSubAgentEntry(entry) {
  return Boolean(entry.parentToolUseId || entry.isMeta);
}

// Incremental .jsonl metadata scan with SQLite cache.
// Reads only the bytes appended since the last scan (append-only assumption).
// Returns { sessionId, cwd, messageCount, lastActivity, lastUserMessage, lastAssistantMessage, mtime }
async function getSessionFileMeta(filePath) {
  const stat = await fs.stat(filePath);
  const currentSize = stat.size;

  const cached = sessionFileCache.get(filePath);

  // Cache hit — file unchanged
  if (cached && cached.file_size === currentSize) {
    return {
      sessionId: cached.session_id,
      cwd: cached.cwd,
      messageCount: cached.message_count,
      lastActivity: cached.last_activity,
      lastUserMessage: cached.last_user_message,
      lastAssistantMessage: cached.last_assistant_message,
      mtime: stat.mtime,
    };
  }

  // Determine read range: read only the delta if file grew, full scan otherwise.
  // When file shrank (replaced), startOffset=0 and we must NOT inherit old cached values.
  const isIncremental = cached && cached.file_size < currentSize;
  const startOffset = isIncremental ? cached.file_size : 0;
  const readSize = currentSize - startOffset;

  let meta = {
    sessionId: isIncremental ? (cached?.session_id ?? null) : null,
    cwd: isIncremental ? (cached?.cwd ?? null) : null,
    messageCount: isIncremental ? (cached?.message_count ?? 0) : 0,
    lastActivity: isIncremental ? (cached?.last_activity ?? null) : null,
    lastUserMessage: isIncremental ? (cached?.last_user_message ?? null) : null,
    lastAssistantMessage: isIncremental ? (cached?.last_assistant_message ?? null) : null,
  };

  if (readSize > 0) {
    const buf = Buffer.allocUnsafe(readSize);
    const fh = await fs.open(filePath, 'r');
    try {
      await fh.read(buf, 0, readSize, startOffset);
    } finally {
      await fh.close();
    }

    // Count newlines for messageCount
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) meta.messageCount++;
    }

    // Parse lines in delta for metadata
    const text = buf.toString('utf8');
    const lines = text.split('\n');

    // Forward scan: grab sessionId/cwd from first parseable entry if not yet known
    if (!meta.sessionId) {
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.sessionId) { meta.sessionId = e.sessionId; meta.cwd = e.cwd || null; break; }
        } catch { /* skip malformed */ }
      }
    }

    // Backward scan: grab latest lastActivity, lastUserMessage, lastAssistantMessage from delta
    let needActivity = true;
    let needUser = true;
    let needAssistant = true;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (needActivity && e.timestamp) {
          meta.lastActivity = e.timestamp;
          needActivity = false;
        }
        if (needUser && e.message?.role === 'user' && e.message?.content) {
          let text = e.message.content;
          if (Array.isArray(text) && text.length > 0 && text[0].type === 'text') text = text[0].text;
          if (typeof text === 'string' && text.length > 0 && !isSubAgentEntry(e)) {
            const isSystem = text.startsWith('<command-name>') || text.startsWith('<system-reminder>') ||
              text.startsWith('Caveat:') || text.startsWith('This session is being continued') ||
              text.includes('{"subtasks":') || text === 'Warmup';
            if (!isSystem) { meta.lastUserMessage = text.slice(0, 500); needUser = false; }
          }
        }
        if (needAssistant && e.message?.role === 'assistant' && e.message?.content && !e.isApiErrorMessage) {
          let assistantText = null;
          if (Array.isArray(e.message.content)) {
            for (const part of e.message.content) {
              if (part.type === 'text' && part.text) assistantText = part.text;
            }
          } else if (typeof e.message.content === 'string') {
            assistantText = e.message.content;
          }
          if (assistantText && !assistantText.includes('{"subtasks":')) {
            meta.lastAssistantMessage = assistantText.slice(0, 500);
            needAssistant = false;
          }
        }
        if (!needActivity && !needUser && !needAssistant) break;
      } catch { /* skip malformed */ }
    }
  }

  // Persist updated metadata to SQLite cache
  try {
    sessionFileCache.upsert({
      file_path: filePath,
      file_size: currentSize,
      session_id: meta.sessionId,
      cwd: meta.cwd,
      message_count: meta.messageCount,
      last_activity: meta.lastActivity,
      last_user_message: meta.lastUserMessage,
      last_assistant_message: meta.lastAssistantMessage,
    });
  } catch (err) {
    console.warn('[WARN] session_file_cache upsert failed:', err.message);
  }

  return { ...meta, mtime: stat.mtime };
}

// Parse an agent JSONL file and extract tool uses
async function parseAgentTools(filePath) {
  const tools = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          // Look for assistant messages with tool_use
          if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_use') {
                tools.push({
                  toolId: part.id,
                  toolName: part.name,
                  toolInput: part.input,
                  timestamp: entry.timestamp
                });
              }
            }
          }
          // Look for tool results
          if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_result') {
                // Find the matching tool and add result
                const tool = tools.find(t => t.toolId === part.tool_use_id);
                if (tool) {
                  tool.toolResult = {
                    content: typeof part.content === 'string' ? part.content :
                      Array.isArray(part.content) ? part.content.map(c => c.text || '').join('\n') :
                        JSON.stringify(part.content),
                    isError: Boolean(part.is_error)
                  };
                }
              }
            }
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }
  } catch (error) {
    console.warn(`Error parsing agent file ${filePath}:`, error.message);
  }

  return tools;
}

function generateStableMessageId(sessionId, timestamp, content) {
  const str = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const hash = crypto.createHash('md5').update(str).digest('hex').slice(0, 6);
  return `${sessionId}_${(timestamp || '').replace(/[^0-9]/g, '').slice(0, 14)}_${hash}`;
}

// Get messages for a specific session with pagination support
async function getSessionMessages(projectName, sessionId, limit = null, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    // Scan for agent files in session subdirectories: {projectDir}/{sessionId}/subagents/agent-{id}.jsonl
    const agentFilesMap = new Map(); // agentFileName -> full path
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      for (const sessionDir of entries.filter(e => e.isDirectory())) {
        const subagentsDir = path.join(projectDir, sessionDir.name, 'subagents');
        try {
          const subagentFiles = await fs.readdir(subagentsDir);
          for (const file of subagentFiles) {
            if (file.endsWith('.jsonl') && file.startsWith('agent-')) {
              agentFilesMap.set(file, path.join(subagentsDir, file));
            }
          }
        } catch (err) {
          // Session directory may not have subagents subdirectory - skip
        }
      }
    } catch (err) {
      // Project directory may not be scannable - continue without agent files
    }

    // Determine which JSONL files to read.
    // Fast path: {sessionId}.jsonl exists → read only that file (contains the full session
    // history, including any parent history copied in during SDK forks).
    // Fallback: scan all files and filter by entry.sessionId (legacy / edge-case sessions
    // that have no dedicated file).
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    let filesToRead; // array of { filePath, filterBySessionId }
    try {
      await fs.access(sessionFile);
      filesToRead = [{ filePath: sessionFile, filterBySessionId: false }];
    } catch {
      const allFiles = await fs.readdir(projectDir);
      const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
      filesToRead = jsonlFiles.map(f => ({ filePath: path.join(projectDir, f), filterBySessionId: true }));
    }

    if (filesToRead.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    // Map of agentId -> tools for subagent tool grouping
    const agentToolsCache = new Map();

    for (const { filePath, filterBySessionId } of filesToRead) {
      const fileStream = fsSync.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (!filterBySessionId || entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            // Silently skip malformed JSONL lines (common with concurrent writes)
          }
        }
      }
    }

    // Collect agentIds from Task tool results
    const agentIds = new Set();
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        agentIds.add(message.toolUseResult.agentId);
      }
    }

    // Load agent tools for each agentId found
    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (agentFilesMap.has(agentFileName)) {
        const agentFilePath = agentFilesMap.get(agentFileName);
        const tools = await parseAgentTools(agentFilePath);
        agentToolsCache.set(agentId, tools);
      }
    }

    // Attach agent tools to their parent Task messages
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        const agentId = message.toolUseResult.agentId;
        const agentTools = agentToolsCache.get(agentId);
        if (agentTools && agentTools.length > 0) {
          message.subagentTools = agentTools;
        }
      }
    }
    // Sort messages by timestamp
    const sortedMessages = messages.sort((a, b) =>
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );

    // Ensure every message has a stable id (JSONL entries use uuid, not id).
    // Track used ids to handle content collisions (e.g. identical queue-operation entries).
    const usedIds = new Set();
    for (const msg of sortedMessages) {
      if (!msg.id) {
        let candidate = msg.uuid || generateStableMessageId(sessionId, msg.timestamp, msg.message?.content);
        let suffix = 0;
        while (usedIds.has(candidate)) {
          suffix++;
          candidate = `${msg.uuid || generateStableMessageId(sessionId, msg.timestamp, msg.message?.content)}_${suffix}`;
        }
        msg.id = candidate;
        usedIds.add(candidate);
      } else {
        usedIds.add(msg.id);
      }
    }

    const total = sortedMessages.length;

    // If no limit is specified, return all messages (backward compatibility)
    if (limit === null) {
      return sortedMessages;
    }

    // Apply pagination - for recent messages, we need to slice from the end
    // offset 0 should give us the most recent messages
    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const actualPath = await extractProjectDirectory(projectName).catch(() => null);
  if (!actualPath) return false;

  const trimmed = newDisplayName?.trim() || null;
  projectsDb.updateProjectCustomName(actualPath, trimmed);
  return true;
}

// Delete a session from a project
async function forkSession(projectName, sessionId, forkAfterTimestamp = null) {
  const { randomUUID } = await import('crypto');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  const files = await fs.readdir(projectDir);
  const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

  for (const file of jsonlFiles) {
    const jsonlFile = path.join(projectDir, file);
    const content = await fs.readFile(jsonlFile, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    // Parse each line once and filter to this session in a single pass.
    const sessionEntries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId === sessionId) sessionEntries.push({ line, entry });
      } catch { /* skip malformed */ }
    }

    if (sessionEntries.length === 0) continue;

    // If forkAfterTimestamp is provided, truncate history at that point.
    // Include all entries whose timestamp <= forkAfterTimestamp.
    if (forkAfterTimestamp) {
      const cutoffTime = new Date(forkAfterTimestamp).getTime();
      let last = -1;
      for (let i = 0; i < sessionEntries.length; i++) {
        const { timestamp } = sessionEntries[i].entry;
        if (timestamp && new Date(timestamp).getTime() <= cutoffTime) {
          last = i;
        }
      }
      if (last >= 0) sessionEntries.splice(last + 1);
    }

    let sessionLines = sessionEntries.map(e => e.line);

    const newSessionId = randomUUID();
    const now = new Date().toISOString();

    // Build a uuid remapping so the forked session has its own unique message IDs.
    // Without this, both sessions share the same first-user-message uuid and the
    // grouping logic in getSessions() collapses them into one group, hiding the original.
    const uuidMap = new Map();
    for (const line of sessionLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) uuidMap.set(entry.uuid, randomUUID());
      } catch {}
    }

    const newLines = sessionLines.map((line, idx) => {
      const entry = JSON.parse(line);
      const newEntry = { ...entry, sessionId: newSessionId };
      if (entry.uuid && uuidMap.has(entry.uuid)) newEntry.uuid = uuidMap.get(entry.uuid);
      if (entry.parentUuid && uuidMap.has(entry.parentUuid)) newEntry.parentUuid = uuidMap.get(entry.parentUuid);
      // Update the last entry's timestamp to now so the fork sorts to the top of the session list.
      if (idx === sessionLines.length - 1 && newEntry.timestamp) newEntry.timestamp = now;
      return JSON.stringify(newEntry);
    });

    const newSessionFile = path.join(projectDir, `${newSessionId}.jsonl`);
    await fs.writeFile(newSessionFile, newLines.join('\n') + '\n', 'utf8');
    return newSessionId;
  }

  throw new Error(`Session ${sessionId} not found in any files`);
}

async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

  try {
    await fs.unlink(sessionFile);
    return true;
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete a project (force=true to delete even with sessions)
async function deleteProject(projectName, force = false) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty && !force) {
      throw new Error('Cannot delete project with existing sessions');
    }

    const projectPath = await extractProjectDirectory(projectName).catch(() => null);

    // Remove the project directory (includes all Claude sessions)
    await fs.rm(projectDir, { recursive: true, force: true });

    // Delete all Codex sessions associated with this project
    if (projectPath) {
      try {
        const codexSessions = await getCodexSessions(projectPath, { limit: 0 });
        for (const session of codexSessions) {
          try {
            await deleteCodexSession(session.id);
          } catch (err) {
            console.warn(`Failed to delete Codex session ${session.id}:`, err.message);
          }
        }
      } catch (err) {
        console.warn('Failed to delete Codex sessions:', err.message);
      }

      // Delete Cursor sessions directory if it exists
      try {
        const hash = crypto.createHash('md5').update(projectPath).digest('hex');
        const cursorProjectDir = path.join(os.homedir(), '.cursor', 'chats', hash);
        await fs.rm(cursorProjectDir, { recursive: true, force: true });
      } catch (err) {
        // Cursor dir may not exist, ignore
      }

      projectsDb.archiveProject(projectPath);
    }

    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (without creating folders)
async function addProjectManually(projectPath, displayName = null) {
  const absolutePath = path.resolve(projectPath);

  try {
    await fs.access(absolutePath);
  } catch (error) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  const projectName = absolutePath.replace(/[\\/:\s~_]/g, '-');

  // Check for conflict in DB
  const existing = projectsDb.getProjectPath(absolutePath);
  if (existing && !existing.isArchived) {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }

  const result = projectsDb.createProjectPath(absolutePath, displayName);
  if (result.outcome === 'active_conflict') {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }

  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectName, absolutePath),
    isManuallyAdded: true,
    sessions: [],
    cursorSessions: []
  };
}

// Fetch Cursor sessions for a given project path
async function getCursorSessions(projectPath) {
  try {
    // Calculate cwdID hash for the project path (Cursor uses MD5 hash)
    const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath = path.join(os.homedir(), '.cursor', 'chats', cwdId);

    // Check if the directory exists
    try {
      await fs.access(cursorChatsPath);
    } catch (error) {
      // No sessions for this project
      return [];
    }

    // List all session directories
    const sessionDirs = await fs.readdir(cursorChatsPath);
    const sessions = [];

    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(cursorChatsPath, sessionId);
      const storeDbPath = path.join(sessionPath, 'store.db');

      try {
        // Check if store.db exists
        await fs.access(storeDbPath);

        // Capture store.db mtime as a reliable fallback timestamp
        let dbStatMtimeMs = null;
        try {
          const stat = await fs.stat(storeDbPath);
          dbStatMtimeMs = stat.mtimeMs;
        } catch (_) { }

        // Open SQLite database
        const db = await open({
          filename: storeDbPath,
          driver: sqlite3.Database,
          mode: sqlite3.OPEN_READONLY
        });

        // Get metadata from meta table
        const metaRows = await db.all(`
          SELECT key, value FROM meta
        `);

        // Parse metadata
        let metadata = {};
        for (const row of metaRows) {
          if (row.value) {
            try {
              // Try to decode as hex-encoded JSON
              const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
              if (hexMatch) {
                const jsonStr = Buffer.from(row.value, 'hex').toString('utf8');
                metadata[row.key] = JSON.parse(jsonStr);
              } else {
                metadata[row.key] = row.value.toString();
              }
            } catch (e) {
              metadata[row.key] = row.value.toString();
            }
          }
        }

        // Get message count
        const messageCountResult = await db.get(`
          SELECT COUNT(*) as count FROM blobs
        `);

        await db.close();

        // Extract session info
        const sessionName = metadata.title || metadata.sessionTitle || 'Untitled Session';

        // Determine timestamp - prefer createdAt from metadata, fall back to db file mtime
        let createdAt = null;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt).toISOString();
        } else if (dbStatMtimeMs) {
          createdAt = new Date(dbStatMtimeMs).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        sessions.push({
          id: sessionId,
          name: sessionName,
          createdAt: createdAt,
          lastActivity: createdAt, // For compatibility with Claude sessions
          messageCount: messageCountResult.count || 0,
          projectPath: projectPath
        });

      } catch (error) {
        console.warn(`Could not read Cursor session ${sessionId}:`, error.message);
      }
    }

    // Sort sessions by creation time (newest first)
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Return only the first 5 sessions for performance
    return sessions.slice(0, 5);

  } catch (error) {
    console.error('Error fetching Cursor sessions:', error);
    return [];
  }
}


function normalizeComparablePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());

  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findCodexJsonlFiles(dir) {
  const files = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findCodexJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return files;
}

async function buildCodexSessionsIndex() {
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const sessionsByProject = new Map();

  try {
    await fs.access(codexSessionsDir);
  } catch (error) {
    return sessionsByProject;
  }

  const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);

  for (const filePath of jsonlFiles) {
    try {
      const sessionData = await parseCodexSessionFile(filePath);
      if (!sessionData || !sessionData.id) {
        continue;
      }

      const normalizedProjectPath = normalizeComparablePath(sessionData.cwd);
      if (!normalizedProjectPath) {
        continue;
      }

      const session = {
        id: sessionData.id,
        summary: sessionData.summary || 'Codex Session',
        messageCount: sessionData.messageCount || 0,
        lastActivity: sessionData.timestamp ? new Date(sessionData.timestamp) : new Date(),
        cwd: sessionData.cwd,
        model: sessionData.model,
        filePath,
        provider: 'codex',
      };

      if (!sessionsByProject.has(normalizedProjectPath)) {
        sessionsByProject.set(normalizedProjectPath, []);
      }

      sessionsByProject.get(normalizedProjectPath).push(session);
    } catch (error) {
      console.warn(`Could not parse Codex session file ${filePath}:`, error.message);
    }
  }

  for (const sessions of sessionsByProject.values()) {
    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  return sessionsByProject;
}

// Fetch Codex sessions for a given project path
async function getCodexSessions(projectPath, options = {}) {
  const { limit = 5, indexRef = null } = options;
  try {
    const normalizedProjectPath = normalizeComparablePath(projectPath);
    if (!normalizedProjectPath) {
      return [];
    }

    if (indexRef && !indexRef.sessionsByProject) {
      indexRef.sessionsByProject = await getCachedCodexIndex();
    }

    const sessionsByProject = indexRef?.sessionsByProject || await getCachedCodexIndex();
    const sessions = sessionsByProject.get(normalizedProjectPath) || [];

    // Return limited sessions for performance (0 = unlimited for deletion)
    return limit > 0 ? sessions.slice(0, limit) : [...sessions];

  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    return [];
  }
}

function isVisibleCodexUserMessage(payload) {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  // Codex logs internal context (environment, instructions) as non-plain user_message kinds.
  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  if (typeof payload.message !== 'string' || payload.message.trim().length === 0) {
    return false;
  }
  
  return true;
}

// Read session_meta from the first few lines of a Codex JSONL file, then stop.
function readFirstCodexSessionMeta(filePath) {
  return new Promise((resolve) => {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let resolved = false;
    let lineCount = 0;

    function finish(result) {
      if (resolved) return;
      resolved = true;
      rl.close();
      stream.destroy();
      resolve(result);
    }

    rl.on('line', (line) => {
      if (resolved || !line.trim()) return;
      lineCount++;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta' && entry.payload) {
          finish({
            id: entry.payload.id,
            cwd: entry.payload.cwd,
            model: entry.payload.model || entry.payload.model_provider,
            timestamp: entry.timestamp,
            git: entry.payload.git
          });
        }
      } catch {}
      if (lineCount >= 20) finish(null);
    });

    rl.on('close', () => finish(null));
    stream.on('error', () => finish(null));
  });
}

// Read the last tailBytes of a Codex JSONL file to extract summary/timestamp.
// Avoids scanning the full file for large sessions.
async function readCodexTailSummary(filePath, tailBytes = 512 * 1024) {
  let lastTimestamp = null;
  let lastUserMessage = null;
  let messageCount = 0;

  try {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return { lastTimestamp, lastUserMessage, messageCount };

    const readSize = Math.min(fileSize, tailBytes);
    const buffer = Buffer.alloc(readSize);
    const fd = await fs.open(filePath, 'r');
    try {
      await fd.read(buffer, 0, readSize, fileSize - readSize);
    } finally {
      await fd.close();
    }

    const text = buffer.toString('utf8');
    // Skip the potentially-truncated first line when reading a partial tail.
    const firstNewline = readSize < fileSize ? text.indexOf('\n') : -1;
    const safeText = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;

    for (const line of safeText.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp) lastTimestamp = entry.timestamp;
        if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload)) {
          messageCount++;
          if (entry.payload.message) lastUserMessage = entry.payload.message;
        }
        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
          messageCount++;
        }
      } catch {}
    }
  } catch {}

  return { lastTimestamp, lastUserMessage, messageCount };
}

// Parse a Codex session JSONL file to extract metadata.
// Reads only the file head (for session_meta) and tail (for summary/timestamp)
// instead of scanning the entire file.
async function parseCodexSessionFile(filePath) {
  try {
    const sessionMeta = await readFirstCodexSessionMeta(filePath);
    if (!sessionMeta) return null;

    const { lastTimestamp, lastUserMessage, messageCount } = await readCodexTailSummary(filePath);

    return {
      ...sessionMeta,
      timestamp: lastTimestamp || sessionMeta.timestamp,
      summary: lastUserMessage ?
        (lastUserMessage.length > 50 ? lastUserMessage.substring(0, 50) + '...' : lastUserMessage) :
        'Codex Session',
      messageCount
    };

  } catch (error) {
    console.error('Error parsing Codex session file:', error);
    return null;
  }
}

// Get messages for a specific Codex session
async function getCodexSessionMessages(sessionId, limit = null, offset = 0) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    // Find the session file by searching for the session ID
    const findSessionFile = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = await findSessionFile(fullPath);
            if (found) return found;
          } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
            return fullPath;
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
      return null;
    };

    const sessionFilePath = await findSessionFile(codexSessionsDir);

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    let tokenUsage = null;
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    // Helper to extract text from Codex content array
    const extractText = (content) => {
      if (!Array.isArray(content)) return content;
      return content
        .map(item => {
          if (item.type === 'input_text' || item.type === 'output_text') {
            return item.text;
          }
          if (item.type === 'text') {
            return item.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    };

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);

          // Extract token usage from token_count events (keep latest)
          if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
            const info = entry.payload.info;
            if (info.total_token_usage) {
              tokenUsage = {
                used: info.total_token_usage.total_tokens || 0,
                total: info.model_context_window || 200000
              };
            }
          }
          
          // Use event_msg.user_message for user-visible inputs.
          if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload)) {
            messages.push({
              type: 'user',
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: entry.payload.message
              }
            });
          }

          // response_item.message may include internal prompts for non-assistant roles.
          // Keep only assistant output from response_item.
          if (
            entry.type === 'response_item' &&
            entry.payload?.type === 'message' &&
            entry.payload.role === 'assistant'
          ) {
            const content = entry.payload.content;
            const textContent = extractText(content);

            // Only add if there's actual content
            if (textContent?.trim()) {
              messages.push({
                type: 'assistant',
                timestamp: entry.timestamp,
                message: {
                  role: 'assistant',
                  content: textContent
                }
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
            const summaryText = entry.payload.summary
              ?.map(s => s.text)
              .filter(Boolean)
              .join('\n');
            if (summaryText?.trim()) {
              messages.push({
                type: 'thinking',
                timestamp: entry.timestamp,
                message: {
                  role: 'assistant',
                  content: summaryText
                }
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
            let toolName = entry.payload.name;
            let toolInput = entry.payload.arguments;

            // Map Codex tool names to Claude equivalents
            if (toolName === 'shell_command') {
              toolName = 'Bash';
              try {
                const args = JSON.parse(entry.payload.arguments);
                toolInput = JSON.stringify({ command: args.command });
              } catch (e) {
                // Keep original if parsing fails
              }
            }

            messages.push({
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: toolName,
              toolInput: toolInput,
              toolCallId: entry.payload.call_id
            });
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
            messages.push({
              type: 'tool_result',
              timestamp: entry.timestamp,
              toolCallId: entry.payload.call_id,
              output: entry.payload.output
            });
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
            const toolName = entry.payload.name || 'custom_tool';
            const input = entry.payload.input || '';

            if (toolName === 'apply_patch') {
              // Parse Codex patch format and convert to Claude Edit format
              const fileMatch = input.match(/\*\*\* Update File: (.+)/);
              const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';

              // Extract old and new content from patch
              const lines = input.split('\n');
              const oldLines = [];
              const newLines = [];

              for (const line of lines) {
                if (line.startsWith('-') && !line.startsWith('---')) {
                  oldLines.push(line.substring(1));
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                  newLines.push(line.substring(1));
                }
              }

              messages.push({
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName: 'Edit',
                toolInput: JSON.stringify({
                  file_path: filePath,
                  old_string: oldLines.join('\n'),
                  new_string: newLines.join('\n')
                }),
                toolCallId: entry.payload.call_id
              });
            } else {
              messages.push({
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName: toolName,
                toolInput: input,
                toolCallId: entry.payload.call_id
              });
            }
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
            messages.push({
              type: 'tool_result',
              timestamp: entry.timestamp,
              toolCallId: entry.payload.call_id,
              output: entry.payload.output || ''
            });
          }

        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

    const total = messages.length;

    // Apply pagination if limit is specified
    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      const paginatedMessages = messages.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage
      };
    }

    return { messages, tokenUsage };

  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

async function deleteCodexSession(sessionId) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    const findJsonlFiles = async (dir) => {
      const files = [];
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await findJsonlFiles(fullPath));
          } else if (entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
          }
        }
      } catch (error) { }
      return files;
    };

    const jsonlFiles = await findJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      const sessionData = await parseCodexSessionFile(filePath);
      if (sessionData && sessionData.id === sessionId) {
        await fs.unlink(filePath);
        return true;
      }
    }

    throw new Error(`Codex session file not found for session ${sessionId}`);
  } catch (error) {
    console.error(`Error deleting Codex session ${sessionId}:`, error);
    throw error;
  }
}

async function searchConversations(query, limit = 50, onProjectResult = null, signal = null, excludePatterns = []) {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const results = [];
  let totalMatches = 0;
  const words = safeQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return { results: [], totalMatches: 0, query: safeQuery };

  const excludedSessionIds = buildExcludedSessionIds('claude');

  const isAborted = () => signal?.aborted === true;

  const isSystemMessage = (textContent) => {
    return typeof textContent === 'string' && (
      textContent.startsWith('<command-name>') ||
      textContent.startsWith('<command-message>') ||
      textContent.startsWith('<command-args>') ||
      textContent.startsWith('<local-command-stdout>') ||
      textContent.startsWith('<system-reminder>') ||
      textContent.startsWith('Caveat:') ||
      textContent.startsWith('This session is being continued from a previous') ||
      textContent.startsWith('Invalid API key') ||
      textContent.includes('{"subtasks":') ||
      textContent.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
      textContent === 'Warmup'
    );
  };

  const extractText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join(' ');
    }
    return '';
  };

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordPatterns = words.map(w => new RegExp(`(?<!\\p{L})${escapeRegex(w)}(?!\\p{L})`, 'u'));
  const allWordsMatch = (textLower) => {
    return wordPatterns.every(p => p.test(textLower));
  };

  const buildSnippet = (text, textLower, snippetLen = 150) => {
    let firstIndex = -1;
    let firstWordLen = 0;
    for (const w of words) {
      const re = new RegExp(`(?<!\\p{L})${escapeRegex(w)}(?!\\p{L})`, 'u');
      const m = re.exec(textLower);
      if (m && (firstIndex === -1 || m.index < firstIndex)) {
        firstIndex = m.index;
        firstWordLen = w.length;
      }
    }
    if (firstIndex === -1) firstIndex = 0;
    const halfLen = Math.floor(snippetLen / 2);
    let start = Math.max(0, firstIndex - halfLen);
    let end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    let snippet = text.slice(start, end).replace(/\n/g, ' ');
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    snippet = prefix + snippet + suffix;
    const snippetLower = snippet.toLowerCase();
    const highlights = [];
    for (const word of words) {
      const re = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
      let match;
      while ((match = re.exec(snippetLower)) !== null) {
        highlights.push({ start: match.index, end: match.index + word.length });
      }
    }
    highlights.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const h of highlights) {
      const last = merged[merged.length - 1];
      if (last && h.start <= last.end) {
        last.end = Math.max(last.end, h.end);
      } else {
        merged.push({ ...h });
      }
    }
    return { snippet, highlights: merged };
  };

  try {
    await fs.access(claudeDir);
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    const projectDirs = entries.filter(e => e.isDirectory());
    let scannedProjects = 0;
    const totalProjects = projectDirs.length;

    for (const projectEntry of projectDirs) {
      if (totalMatches >= safeLimit || isAborted()) break;

      const projectName = projectEntry.name;
      const projectDir = path.join(claudeDir, projectName);
      const actualDir = await extractProjectDirectory(projectName).catch(() => null);

      if (actualDir && excludePatterns.length > 0) {
        const isExcluded = excludePatterns.some((pattern) => {
          try { return new RegExp(pattern, 'i').test(actualDir); } catch { return false; }
        });
        if (isExcluded) { scannedProjects++; continue; }
      }

      const displayName = (actualDir && projectsDb.getProjectPath(actualDir)?.custom_project_name)
        || await generateDisplayName(projectName);

      let files;
      try {
        files = await fs.readdir(projectDir);
      } catch {
        continue;
      }

      const jsonlFiles = files.filter(
        file => file.endsWith('.jsonl') && !file.startsWith('agent-')
      );

      const projectResult = {
        projectName,
        projectDisplayName: displayName,
        sessions: []
      };

      for (const file of jsonlFiles) {
        if (totalMatches >= safeLimit || isAborted()) break;

        // Skip entire file if it belongs to an auto-doc session (file-level filter).
        // Entry-level filtering is unreliable because the SDK rewrites the file using
        // the source session's ID instead of the fork ID.
        const fileSessionId = file.replace('.jsonl', '');
        if (excludedSessionIds.has(fileSessionId)) continue;

        const filePath = path.join(projectDir, file);
        // Use filename as the canonical sessionId — avoids duplicates caused by
        // the SDK writing source-session IDs into fork files.
        let fileSummary = null;
        const pendingSummaries = new Map();
        let fileLastMessages = {};
        const fileMatches = [];

        try {
          const fileStream = fsSync.createReadStream(filePath);
          const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
          });

          for await (const line of rl) {
            if (totalMatches >= safeLimit || isAborted()) break;
            if (!line.trim()) continue;

            let entry;
            try {
              entry = JSON.parse(line);
            } catch {
              continue;
            }

            if (entry.type === 'summary' && entry.summary) {
              fileSummary = entry.summary;
            }

            // Apply pending summary via leafUuid/parentUuid chain
            if (!fileSummary && entry.leafUuid) {
              pendingSummaries.set(entry.leafUuid, entry.summary);
            }
            if (!fileSummary && entry.parentUuid) {
              const pending = pendingSummaries.get(entry.parentUuid);
              if (pending) fileSummary = pending;
            }

            // Track last user/assistant message for fallback title
            if (entry.message?.content && !entry.isApiErrorMessage) {
              const role = entry.message.role;
              if (role === 'user' || role === 'assistant') {
                const text = extractText(entry.message.content);
                if (text && !isSystemMessage(text) && !(role === 'user' && isSubAgentEntry(entry))) {
                  if (role === 'user') fileLastMessages.user = text;
                  else fileLastMessages.assistant = text;
                }
              }
            }

            if (!entry.message?.content) continue;
            if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue;
            if (entry.isApiErrorMessage) continue;

            const text = extractText(entry.message.content);
            if (!text || isSystemMessage(text)) continue;

            const textLower = text.toLowerCase();
            if (!allWordsMatch(textLower)) continue;

            if (fileMatches.length < 2) {
              const { snippet, highlights } = buildSnippet(text, textLower);
              fileMatches.push({
                role: entry.message.role,
                snippet,
                highlights,
                timestamp: entry.timestamp || null,
                provider: 'claude',
                messageUuid: entry.uuid || null
              });
              totalMatches++;
            }
          }
        } catch {
          continue;
        }

        if (fileMatches.length > 0) {
          const lastMsg = fileLastMessages.user || fileLastMessages.assistant;
          projectResult.sessions.push({
            sessionId: fileSessionId,
            provider: 'claude',
            sessionSummary: fileSummary || (lastMsg
              ? (lastMsg.length > 50 ? lastMsg.substring(0, 50) + '...' : lastMsg)
              : 'New Session'),
            matches: fileMatches
          });
        }
      }

      // Search Codex sessions for this project
      try {
        const actualProjectDir = await extractProjectDirectory(projectName);
        if (actualProjectDir && !isAborted() && totalMatches < safeLimit) {
          await searchCodexSessionsForProject(
            actualProjectDir, projectResult, words, allWordsMatch, extractText, isSystemMessage,
            buildSnippet, safeLimit, () => totalMatches, (n) => { totalMatches += n; }, isAborted
          );
        }
      } catch {
        // Skip codex search errors
      }

      // Search Gemini sessions for this project
      try {
        const actualProjectDir = await extractProjectDirectory(projectName);
        if (actualProjectDir && !isAborted() && totalMatches < safeLimit) {
          await searchGeminiSessionsForProject(
            actualProjectDir, projectResult, words, allWordsMatch,
            buildSnippet, safeLimit, () => totalMatches, (n) => { totalMatches += n; }
          );
        }
      } catch {
        // Skip gemini search errors
      }

      scannedProjects++;
      if (projectResult.sessions.length > 0) {
        results.push(projectResult);
        if (onProjectResult) {
          onProjectResult({ projectResult, totalMatches, scannedProjects, totalProjects });
        }
      } else if (onProjectResult && scannedProjects % 10 === 0) {
        onProjectResult({ projectResult: null, totalMatches, scannedProjects, totalProjects });
      }
    }
  } catch {
    // claudeDir doesn't exist
  }

  return { results, totalMatches, query: safeQuery };
}

async function searchCodexSessionsForProject(
  projectPath, projectResult, words, allWordsMatch, extractText, isSystemMessage,
  buildSnippet, limit, getTotalMatches, addMatches, isAborted
) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return;
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  try {
    await fs.access(codexSessionsDir);
  } catch {
    return;
  }

  const jsonlFiles = await findCodexJsonlFiles(codexSessionsDir);

  for (const filePath of jsonlFiles) {
    if (getTotalMatches() >= limit || isAborted()) break;

    try {
      const fileStream = fsSync.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      // First pass: read session_meta to check project path match
      let sessionMeta = null;
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session_meta' && entry.payload) {
            sessionMeta = entry.payload;
            break;
          }
        } catch { continue; }
      }

      // Skip sessions that don't belong to this project
      if (!sessionMeta) continue;
      const sessionProjectPath = normalizeComparablePath(sessionMeta.cwd);
      if (sessionProjectPath !== normalizedProjectPath) continue;

      // Second pass: re-read file to find matching messages
      const fileStream2 = fsSync.createReadStream(filePath);
      const rl2 = readline.createInterface({ input: fileStream2, crlfDelay: Infinity });
      let lastUserMessage = null;
      const matches = [];

      for await (const line of rl2) {
        if (getTotalMatches() >= limit || isAborted()) break;
        if (!line.trim()) continue;

        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        let text = null;
        let role = null;

        if (entry.type === 'event_msg' && entry.payload?.type === 'user_message' && entry.payload.message) {
          text = entry.payload.message;
          role = 'user';
          lastUserMessage = text;
        } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
          const contentParts = entry.payload.content || [];
          if (entry.payload.role === 'user') {
            text = contentParts
              .filter(p => p.type === 'input_text' && p.text)
              .map(p => p.text)
              .join(' ');
            role = 'user';
            if (text) lastUserMessage = text;
          } else if (entry.payload.role === 'assistant') {
            text = contentParts
              .filter(p => p.type === 'output_text' && p.text)
              .map(p => p.text)
              .join(' ');
            role = 'assistant';
          }
        }

        if (!text || !role) continue;
        const textLower = text.toLowerCase();
        if (!allWordsMatch(textLower)) continue;

        if (matches.length < 2) {
          const { snippet, highlights } = buildSnippet(text, textLower);
          matches.push({ role, snippet, highlights, timestamp: entry.timestamp || null, provider: 'codex' });
          addMatches(1);
        }
      }

      if (matches.length > 0) {
        projectResult.sessions.push({
          sessionId: sessionMeta.id,
          provider: 'codex',
          sessionSummary: lastUserMessage
            ? (lastUserMessage.length > 50 ? lastUserMessage.substring(0, 50) + '...' : lastUserMessage)
            : 'Codex Session',
          matches
        });
      }
    } catch {
      continue;
    }
  }
}

async function searchGeminiSessionsForProject(
  projectPath, projectResult, words, allWordsMatch,
  buildSnippet, limit, getTotalMatches, addMatches
) {
  // 1) Search in-memory sessions (created via UI)
  for (const [sessionId, session] of sessionManager.sessions) {
    if (getTotalMatches() >= limit) break;
    if (session.projectPath !== projectPath) continue;

    const matches = [];
    for (const msg of session.messages) {
      if (getTotalMatches() >= limit) break;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : '';
      if (!text) continue;

      const textLower = text.toLowerCase();
      if (!allWordsMatch(textLower)) continue;

      if (matches.length < 2) {
        const { snippet, highlights } = buildSnippet(text, textLower);
        matches.push({
          role: msg.role, snippet, highlights,
          timestamp: msg.timestamp ? msg.timestamp.toISOString() : null,
          provider: 'gemini'
        });
        addMatches(1);
      }
    }

    if (matches.length > 0) {
      const firstUserMsg = session.messages.find(m => m.role === 'user');
      const summary = firstUserMsg?.content
        ? (typeof firstUserMsg.content === 'string'
          ? (firstUserMsg.content.length > 50 ? firstUserMsg.content.substring(0, 50) + '...' : firstUserMsg.content)
          : 'Gemini Session')
        : 'Gemini Session';

      projectResult.sessions.push({
        sessionId,
        provider: 'gemini',
        sessionSummary: summary,
        matches
      });
    }
  }

  // 2) Search Gemini CLI sessions on disk (~/.gemini/tmp/<project>/chats/*.json)
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return;

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  try {
    await fs.access(geminiTmpDir);
  } catch {
    return;
  }

  const trackedSessionIds = new Set();
  for (const [sid] of sessionManager.sessions) {
    trackedSessionIds.add(sid);
  }

  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    if (getTotalMatches() >= limit) break;

    const projectRootFile = path.join(geminiTmpDir, projectDir, '.project_root');
    let projectRoot;
    try {
      projectRoot = (await fs.readFile(projectRootFile, 'utf8')).trim();
    } catch {
      continue;
    }

    if (normalizeComparablePath(projectRoot) !== normalizedProjectPath) continue;

    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (getTotalMatches() >= limit) break;
      if (!chatFile.endsWith('.json')) continue;

      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        if (!session.messages || !Array.isArray(session.messages)) continue;

        const cliSessionId = session.sessionId || chatFile.replace('.json', '');
        if (trackedSessionIds.has(cliSessionId)) continue;

        const matches = [];
        let firstUserText = null;

        for (const msg of session.messages) {
          if (getTotalMatches() >= limit) break;

          const role = msg.type === 'user' ? 'user'
            : (msg.type === 'gemini' || msg.type === 'assistant') ? 'assistant'
            : null;
          if (!role) continue;

          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(p => p.text)
              .map(p => p.text)
              .join(' ');
          }
          if (!text) continue;

          if (role === 'user' && !firstUserText) firstUserText = text;

          const textLower = text.toLowerCase();
          if (!allWordsMatch(textLower)) continue;

          if (matches.length < 2) {
            const { snippet, highlights } = buildSnippet(text, textLower);
            matches.push({
              role, snippet, highlights,
              timestamp: msg.timestamp || null,
              provider: 'gemini'
            });
            addMatches(1);
          }
        }

        if (matches.length > 0) {
          const summary = firstUserText
            ? (firstUserText.length > 50 ? firstUserText.substring(0, 50) + '...' : firstUserText)
            : 'Gemini CLI Session';

          projectResult.sessions.push({
            sessionId: cliSessionId,
            provider: 'gemini',
            sessionSummary: summary,
            matches
          });
        }
      } catch {
        continue;
      }
    }
  }
}

async function getGeminiCliSessions(projectPath) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  if (!normalizedProjectPath) return [];

  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  try {
    await fs.access(geminiTmpDir);
  } catch {
    return [];
  }

  const sessions = [];
  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectRootFile = path.join(geminiTmpDir, projectDir, '.project_root');
    let projectRoot;
    try {
      projectRoot = (await fs.readFile(projectRootFile, 'utf8')).trim();
    } catch {
      continue;
    }

    if (normalizeComparablePath(projectRoot) !== normalizedProjectPath) continue;

    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) continue;
      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        if (!session.messages || !Array.isArray(session.messages)) continue;

        const sessionId = session.sessionId || chatFile.replace('.json', '');
        const firstUserMsg = session.messages.find(m => m.type === 'user');
        let summary = 'Gemini CLI Session';
        if (firstUserMsg) {
          const text = Array.isArray(firstUserMsg.content)
            ? firstUserMsg.content.filter(p => p.text).map(p => p.text).join(' ')
            : (typeof firstUserMsg.content === 'string' ? firstUserMsg.content : '');
          if (text) {
            summary = text.length > 50 ? text.substring(0, 50) + '...' : text;
          }
        }

        sessions.push({
          id: sessionId,
          summary,
          messageCount: session.messages.length,
          lastActivity: session.lastUpdated || session.startTime || null,
          provider: 'gemini'
        });
      } catch {
        continue;
      }
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
  );
}

async function getGeminiCliSessionMessages(sessionId) {
  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  let projectDirs;
  try {
    projectDirs = await fs.readdir(geminiTmpDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const chatsDir = path.join(geminiTmpDir, projectDir, 'chats');
    let chatFiles;
    try {
      chatFiles = await fs.readdir(chatsDir);
    } catch {
      continue;
    }

    for (const chatFile of chatFiles) {
      if (!chatFile.endsWith('.json')) continue;
      try {
        const filePath = path.join(chatsDir, chatFile);
        const data = await fs.readFile(filePath, 'utf8');
        const session = JSON.parse(data);
        const fileSessionId = session.sessionId || chatFile.replace('.json', '');
        if (fileSessionId !== sessionId) continue;

        return (session.messages || []).map(msg => {
          const role = msg.type === 'user' ? 'user'
            : (msg.type === 'gemini' || msg.type === 'assistant') ? 'assistant'
            : msg.type;

          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content.filter(p => p.text).map(p => p.text).join('\n');
          }

          return {
            type: 'message',
            message: { role, content },
            timestamp: msg.timestamp || null
          };
        });
      } catch {
        continue;
      }
    }
  }

  return [];
}

export {
  getProjects,
  getSessions,
  getSessionMessages,
  getSessionFileMeta,
  renameProject,
  deleteSession,
  forkSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  getCodexSessions,
  getCodexSessionMessages,
  deleteCodexSession,
  getGeminiCliSessions,
  getGeminiCliSessionMessages,
  searchConversations
};
