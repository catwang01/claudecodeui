/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { getTapSession } from './tap.js';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { claudeAdapter } from './providers/claude/adapter.js';
import { createNormalizedMessage } from './providers/types.js';
import { appendMessage, appendMessageAsync } from './utils/localMessageWriter.js';
import { appConfigDb } from './modules/database/index.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();

const downloadTool = tool(
  'download',
  'Make an existing file available for the user to download. Call this when the user asks you to generate or prepare a file for download. The file must already exist on disk.',
  { filepath: z.string().describe('Absolute path to the file to make available for download') },
  async (args) => {
    const { filepath } = args;
    const absolutePath = path.isAbsolute(filepath) ? filepath : path.join(process.cwd(), filepath);
    await fs.access(absolutePath);
    const stats = await fs.stat(absolutePath);
    const filename = path.basename(absolutePath);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          filepath: absolutePath,
          filename,
          downloadUrl: `/api/download?filepath=${encodeURIComponent(absolutePath)}`,
          fileSize: stats.size,
          message: `File "${filename}" is ready. IMPORTANT: Do NOT mention the downloadUrl, do NOT create any hyperlinks or markdown links, and do NOT instruct the user how to download. The UI will automatically display a download button — simply tell the user the file is ready.`
        })
      }]
    };
  },
  { annotations: { readOnlyHint: true } }
);

const imageTool = tool(
  'image',
  'Display an image inline in the chat UI. Call this when the user asks to see an image or when showing a generated/existing image would be helpful. The file must already exist on disk.',
  { filepath: z.string().describe('Absolute path to the image file to display') },
  async (args) => {
    const { filepath } = args;
    const absolutePath = path.isAbsolute(filepath) ? filepath : path.join(process.cwd(), filepath);
    await fs.access(absolutePath);
    const stats = await fs.stat(absolutePath);
    const filename = path.basename(absolutePath);
    const ext = path.extname(filename).toLowerCase().slice(1);
    const mimeTypeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
    const mimeType = mimeTypeMap[ext] || 'image/png';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          filepath: absolutePath,
          filename,
          imageUrl: `/api/image?filepath=${encodeURIComponent(absolutePath)}`,
          fileSize: stats.size,
          mimeType,
          message: `Image "${filename}" is ready. IMPORTANT: Do NOT mention the imageUrl, do NOT create any hyperlinks or markdown links. The UI will automatically display the image inline — simply describe the image content to the user.`
        })
      }]
    };
  },
  { annotations: { readOnlyHint: true } }
);

function createInternalToolsServer() {
  return createSdkMcpServer({ name: 'internal', version: '1.0.0', tools: [downloadTool, imageTool] });
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion']);

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;

  const sdkOptions = {};

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Always allow the built-in UI MCP tools
  if (!sdkOptions.allowedTools.includes('mcp__internal__download')) {
    sdkOptions.allowedTools.push('mcp__internal__download');
  }

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model (default to claude-sonnet-4.6)
  // Valid models: claude-opus-4.7, claude-opus-4.6, claude-sonnet-4.6, claude-sonnet-4.5, claude-haiku-4.5
  // IMPORTANT: Use dot notation (4.6), not dash notation (4-6)
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;
  // Model logged at query start below

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // Fork session (creates a new session branched from the resumed session)
  if (options.forkSession) {
    sdkOptions.forkSession = true;
  }

  // Max turns (limits the number of agentic turns)
  if (options.maxTurns != null) {
    sdkOptions.maxTurns = options.maxTurns;
  }

  // Remove CLAUDECODE env var so the spawned claude CLI doesn't refuse to start
  // when the server itself is running inside a Claude Code session.
  const env = { ...process.env };
  delete env.CLAUDECODE;

  sdkOptions.env = env;

  // Only override the executable path when explicitly configured.
  // Otherwise let the SDK auto-detect bundled native binary/cli.js fallback.
  if (process.env.CLAUDE_CLI_PATH) {
    sdkOptions.pathToClaudeCodeExecutable = process.env.CLAUDE_CLI_PATH;
  }

  // If a per-session claude-tap proxy is running, override ANTHROPIC_BASE_URL via extraArgs.settings.
  const tapSession = sessionId ? getTapSession(sessionId) : null;
  if (tapSession) {
    const tapUrl = `http://127.0.0.1:${tapSession.proxyPort}`;
    sdkOptions.extraArgs = {
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: tapUrl }
      })
    };
    console.log(`[tap] session ${sessionId.slice(0, 8)}: ANTHROPIC_BASE_URL=${tapUrl}`);
  }

  // If PII proxy is running (PII_PROXY_PORT is set), inject ANTHROPIC_BASE_URL unless tap already did.
  const piiProxyPort = process.env.PII_PROXY_PORT;
  const piiEnabled = appConfigDb.get('pii_proxy_enabled');
  if (piiProxyPort && !tapSession && (piiEnabled === null || piiEnabled === 'true')) {
    const piiUrl = `http://127.0.0.1:${piiProxyPort}`;
    sdkOptions.extraArgs = {
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: piiUrl }
      })
    };
    console.log(`[pii-proxy] ANTHROPIC_BASE_URL=${piiUrl}`);
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, abortController = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    abortController,
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

function appendToSessionLog(sessionId, content) {
  const logsDir = path.join(os.homedir(), '.claudecodeui', 'logs');
  const logPath = path.join(logsDir, `${sessionId}.log`);
  fs.mkdir(logsDir, { recursive: true })
    .then(() => fs.appendFile(logPath, content + '\n', 'utf8'))
    .catch(() => {});
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  // Get the first model's usage data
  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];

  if (!modelData) {
    return null;
  }

  // Use cumulative tokens if available (tracks total for the session)
  // Otherwise fall back to per-request tokens
  const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;

  // Total used = input + output + cache tokens
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Use configured context window budget from environment (default 160000)
  // This is the user's budget limit, not the model's context window
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;

  // Token calc logged via token-budget WS event

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    // Temp files cleaned
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let userMessageWritten = false;

  // Write Point A: resume session — session ID already known.
  // Skip if no localMessageId: a message without a stable ID can't be deduped later.
  if (capturedSessionId && command && options.localMessageId) {
    appendMessage(capturedSessionId, createNormalizedMessage({
      kind: 'text', role: 'user', content: command,
      sessionId: capturedSessionId, provider: 'claude',
      id: options.localMessageId,
    }));
    userMessageWritten = true;
  }

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  let userAborted = false;

  try {
    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(options);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    sdkOptions.mcpServers = { ...(mcpServers || {}), internal: createInternalToolsServer() };

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    const STALL_TIMEOUT_MS = options.stallTimeoutMs ?? 120000;
    const MAX_STALL_RETRIES = 3;
    const MAX_CONTEXT_MGMT_RETRIES = 1; // reduced: first attempt uses /compact, not blind retry
    const MAX_TOKEN_LIMIT_RETRIES = 2;
    let stallRetryCount = 0;
    let contextMgmtRetryCount = 0;
    let tokenLimitRetryCount = 0;
    let retryExhausted = false;
    // Two-phase compaction: phase 1 sends /compact, phase 2 resumes to continue original task
    let compactPhase = false;

    let _msgCount = 0;
    const pendingDownloadToolIds = new Set();
    const pendingImageToolIds = new Set();

    while (true) {
      let hasContextMgmtError = false;
      let hasApiStreamError = false;
      const abortController = new AbortController();
      const queryEnv = {
        ...sdkOptions.env,
        CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(STALL_TIMEOUT_MS),
      };

      // On retry, resume the session from disk; first run uses the original prompt.
      const isRetry = (stallRetryCount > 0 || contextMgmtRetryCount > 0 || tokenLimitRetryCount > 0 || compactPhase) && capturedSessionId;

      // Determine the prompt for this iteration:
      // - compactPhase=true (phase 2 after /compact): empty resume to continue original task
      // - contextMgmtRetryCount===1 (phase 1): send /compact to trigger native CLI compaction
      // - other retries: empty resume
      // - first run: original user prompt
      let promptForThisRun;
      if (compactPhase) {
        promptForThisRun = ''; // phase 2: resume after /compact, continue original task
        compactPhase = false;
      } else if (contextMgmtRetryCount === 1) {
        promptForThisRun = '/compact'; // phase 1: trigger native CLI compaction
      } else if (isRetry) {
        promptForThisRun = '';
      } else {
        promptForThisRun = finalCommand;
      }

      const queryOpts = {
        ...sdkOptions,
        abortController,
        env: queryEnv,
        ...(isRetry ? { resume: capturedSessionId, prompt: undefined } : {}),
      };

      let queryInstance;
      try {
        queryInstance = query({
          prompt: promptForThisRun,
          options: queryOpts,
        });
      } catch (hookError) {
        // Older/newer SDK versions may not accept hook shapes yet.
        // Keep notification behavior operational via runtime events even if hook registration fails.
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete queryOpts.hooks;
        queryInstance = query({
          prompt: isRetry ? '' : finalCommand,
          options: queryOpts,
        });
      }

      // Track the query instance for abort capability.
      // Use capturedSessionId if known (resume), otherwise fall back to the
      // caller-supplied sessionId so that isProcessing / startTime are
      // available immediately — even during the silent compaction phase
      // before the SDK yields its first message.
      const trackId = capturedSessionId || sessionId;
      if (trackId) {
        addSession(trackId, queryInstance, tempImagePaths, tempDir, ws, abortController);
      }

      // Process streaming messages
      appendToSessionLog(capturedSessionId || sessionId || 'unknown', `[${new Date().toISOString()}] Starting async generator loop for session: ${capturedSessionId || 'NEW'}${isRetry ? ` (stall retry #${stallRetryCount})` : ''}`);
      let forAwaitError = null;
      try {
      for await (const message of queryInstance) {
      _msgCount++;
      const _sid = capturedSessionId || sessionId || 'unknown';
      appendToSessionLog(_sid, `[${new Date().toISOString()}] [SDK] msg#${_msgCount} ${JSON.stringify(message, null, 2)}`);
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        // If we pre-registered under the caller-supplied sessionId (which may
        // differ from the SDK-assigned capturedSessionId), remove that entry first.
        if (sessionId && sessionId !== capturedSessionId) {
          removeSession(sessionId);
        }
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, abortController);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Write Point B: new session — await the write BEFORE notifying frontend,
        // so fetchFromServer triggered by session_created always finds it in local JSONL.
        // Skip if no localMessageId: a message without a stable ID can't be deduped later.
        if (command && !userMessageWritten && options.localMessageId) {
          await appendMessageAsync(capturedSessionId, createNormalizedMessage({
            kind: 'text', role: 'user', content: command,
            sessionId: capturedSessionId, provider: 'claude',
            id: options.localMessageId,
          }));
          userMessageWritten = true;
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Detect SDK synthetic error messages (e.g. stream idle timeout, token limit exceeded).
      // These arrive as normal stream items (not thrown exceptions) with error: 'unknown'
      // and model '<synthetic>', so the AbortError stall-retry path never fires for them.
      // The '<synthetic>' guard prevents retrying genuinely non-retriable errors that might
      // also carry error: 'unknown' (e.g. invalid_request surfaced synthetically in future SDK versions).
      if (message.type === 'assistant' && message.error === 'unknown' &&
          message.message?.model === '<synthetic>') {
        hasApiStreamError = true;
        appendToSessionLog(capturedSessionId || sessionId || 'unknown', `[${new Date().toISOString()}] [SDK] synthetic API error detected (error: unknown), will retry`);
        continue; // skip normalization; handled after the for-await loop
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = claudeAdapter.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }

        // Detect context_management compaction failure — intercept and retry instead of showing raw error
        if (msg.kind === 'text' && typeof msg.content === 'string' &&
            msg.content.includes('context_management: Extra inputs are not permitted')) {
          hasContextMgmtError = true;
          appendMessage(capturedSessionId || sessionId || null, msg); // keep in JSONL for debug
          continue; // don't send to frontend yet; will retry
        }

        ws.send(msg);
        // Persist each stream message to local JSONL as history
        appendMessage(capturedSessionId || sessionId || null, msg);

        // Track download tool_use calls
        if (msg.kind === 'tool_use' && msg.toolName === 'mcp__internal__download') {
          pendingDownloadToolIds.add(msg.toolId);
        }

        // Track image tool_use calls
        if (msg.kind === 'tool_use' && msg.toolName === 'mcp__internal__image') {
          pendingImageToolIds.add(msg.toolId);
        }

        // Intercept download tool_result and emit a file_download card
        if (msg.kind === 'tool_result' && pendingDownloadToolIds.has(msg.toolId)) {
          pendingDownloadToolIds.delete(msg.toolId);
          try {
            let resultText = msg.content;
            try {
              const parsed = JSON.parse(resultText);
              if (Array.isArray(parsed) && parsed[0]?.text) {
                resultText = parsed[0].text;
              }
            } catch (_) {}
            const resultData = JSON.parse(resultText);
            const downloadMsg = createNormalizedMessage({
              kind: 'file_download',
              sessionId: capturedSessionId || sessionId || null,
              provider: 'claude',
              filename: resultData.filename,
              filepath: resultData.filepath,
              downloadUrl: resultData.downloadUrl,
              fileSize: resultData.fileSize,
            });
            ws.send(downloadMsg);
            appendMessage(capturedSessionId || sessionId || null, downloadMsg);
          } catch (e) {
            console.error('Failed to emit file_download message:', e);
          }
        }

        // Intercept image tool_result and emit an image_display card
        if (msg.kind === 'tool_result' && pendingImageToolIds.has(msg.toolId)) {
          pendingImageToolIds.delete(msg.toolId);
          try {
            let resultText = msg.content;
            try {
              const parsed = JSON.parse(resultText);
              if (Array.isArray(parsed) && parsed[0]?.text) {
                resultText = parsed[0].text;
              }
            } catch (_) {}
            const resultData = JSON.parse(resultText);
            const imageMsg = createNormalizedMessage({
              kind: 'image_display',
              sessionId: capturedSessionId || sessionId || null,
              provider: 'claude',
              filename: resultData.filename,
              filepath: resultData.filepath,
              imageUrl: resultData.imageUrl,
              fileSize: resultData.fileSize,
              mimeType: resultData.mimeType,
            });
            ws.send(imageMsg);
            appendMessage(capturedSessionId || sessionId || null, imageMsg);
          } catch (e) {
            console.error('Failed to emit image_display message:', e);
          }
        }
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        const models = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          // Model info available in result message
        }
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }
      } // close for await
      } catch (err) {
        forAwaitError = err;
      }

      if (forAwaitError) {
        // Distinguish stall abort (watchdog fired) from user-initiated abort.
        // User abort sets session.status = 'aborted' before calling interrupt().
        // If the session was removed or marked aborted, don't retry.
        const sessionSnap = getSession(capturedSessionId);
        const isUserAbort = !sessionSnap || sessionSnap.status === 'aborted';
        if (isUserAbort) userAborted = true;
        const isStall = forAwaitError.name === 'AbortError' && !isUserAbort;

        if (isStall && stallRetryCount < MAX_STALL_RETRIES) {
          stallRetryCount++;
          console.warn(`[STALL-RETRY] Session ${capturedSessionId} stalled (no stream activity for ${STALL_TIMEOUT_MS}ms), retry ${stallRetryCount}/${MAX_STALL_RETRIES}`);
          ws.send(createNormalizedMessage({ kind: 'status', text: 'stall_retry', retryCount: stallRetryCount, maxRetries: MAX_STALL_RETRIES, errorMessage: `Stream stalled for ${STALL_TIMEOUT_MS / 1000}s`, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          continue; // retry with resume
        }

        // Token limit exceeded thrown as exception (not synthetic message) — force compaction and retry
        const isTokenLimitError = forAwaitError.message?.includes('model_max_prompt_tokens_exceeded');
        if (isTokenLimitError && tokenLimitRetryCount < MAX_TOKEN_LIMIT_RETRIES) {
          tokenLimitRetryCount++;
          console.warn(`[TOKEN-LIMIT-RETRY] Session ${capturedSessionId} hit token limit (thrown), sending /compact to trigger native CLI compaction (attempt ${tokenLimitRetryCount}/${MAX_TOKEN_LIMIT_RETRIES})`);
          // Use two-phase /compact approach: bypass SDK's broken context_management API parameter.
          // Phase 1: send /compact so claude CLI handles compaction natively.
          // compactPhase=true tells next iteration (phase 2) to resume with empty prompt to continue.
          compactPhase = true;
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_limit_retry', retryCount: tokenLimitRetryCount, maxRetries: MAX_TOKEN_LIMIT_RETRIES, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          continue;
        } else if (isTokenLimitError) {
          retryExhausted = true;
          ws.send(createNormalizedMessage({ kind: 'error', content: 'Context too large after compaction retries. Please start a new session.', sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          break;
        }

        // Non-retryable: propagate to outer catch
        throw forAwaitError;
      }

      // context_management compaction error detected in stream — retry transparently
      if (hasContextMgmtError && contextMgmtRetryCount < MAX_CONTEXT_MGMT_RETRIES) {
        contextMgmtRetryCount++;
        console.warn(`[CONTEXT-MGMT-RETRY] Session ${capturedSessionId} compaction failed (Extra inputs), sending /compact to trigger native CLI compaction (attempt ${contextMgmtRetryCount}/${MAX_CONTEXT_MGMT_RETRIES})`);
        // Phase 1: send /compact as user message so claude CLI handles compaction natively,
        // bypassing the SDK's broken context_management API parameter.
        // compactPhase=true tells next iteration (phase 2) to resume with empty prompt to continue.
        compactPhase = true;
        ws.send(createNormalizedMessage({ kind: 'status', text: 'context_mgmt_retry', retryCount: contextMgmtRetryCount, maxRetries: MAX_CONTEXT_MGMT_RETRIES, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        continue;
      } else if (hasContextMgmtError) {
        // All retries exhausted — surface the error to the user
        retryExhausted = true;
        ws.send(createNormalizedMessage({ kind: 'error', content: 'Context compaction failed after retries. Try /compact manually or start a new session.', sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      // Token limit exceeded — force compaction by setting a very low autoCompactThreshold and resume
      // SDK synthetic API error (e.g. stream idle timeout) — retry using resume
      if (hasApiStreamError && stallRetryCount < MAX_STALL_RETRIES) {
        stallRetryCount++;
        console.warn(`[STALL-RETRY] Session ${capturedSessionId} received synthetic API error (stream idle timeout), retry ${stallRetryCount}/${MAX_STALL_RETRIES}`);
        ws.send(createNormalizedMessage({ kind: 'status', text: 'stall_retry', retryCount: stallRetryCount, maxRetries: MAX_STALL_RETRIES, errorMessage: 'Stream idle timeout', sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        continue;
      } else if (hasApiStreamError) {
        retryExhausted = true;
        ws.send(createNormalizedMessage({ kind: 'error', content: 'Stream idle timeout after retries. Please try again.', sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      // for await completed normally — exit retry loop
      break;
    } // end while (retry loop)

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Wait for file system watcher to flush projects_updated before notifying client
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send completion event (skip if retries were exhausted — frontend already received kind: 'error')
    if (!retryExhausted) {
      ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude' }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send error to WebSocket (skip for user-initiated aborts — they're not real errors)
    if (!userAborted) {
      ws.send(createNormalizedMessage({ kind: 'error', content: error.message, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });

    throw error;
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark as aborted and remove immediately so polling stops returning isProcessing: true.
    // This lets the caller send complete{aborted:true} without waiting for the API to respond.
    // Setting status BEFORE abort/interrupt ensures the stall-retry logic sees it and does not retry.
    session.status = 'aborted';
    removeSession(sessionId);

    // Signal the AbortController (used by CLAUDE_ENABLE_STREAM_WATCHDOG and SDK internals).
    session.abortController?.abort();

    // Call interrupt() and cleanup in background — do NOT await so the caller returns
    // immediately and the client gets visual feedback right away.
    session.instance.interrupt()
      .then(() => cleanupTempFiles(session.tempImagePaths, session.tempDir))
      .catch(err => {
        console.error(`[ABORT] interrupt() error for session ${sessionId}:`, err.message);
      });

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

function getClaudeSDKSessionStartTime(sessionId) {
  return getSession(sessionId)?.startTime ?? null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  // Only swap writer if the WebSocket has actually changed (e.g. page refresh),
  // not on routine heartbeat check-session-status polls.
  if (session.writer.ws === newRawWs) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
};
