// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock heavy dependencies before importing the module under test ---

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn(() => ({})),
  createSdkMcpServer: vi.fn(() => ({})),
}));

vi.mock('./utils/localMessageWriter.js', () => ({
  appendMessage: vi.fn(),
  appendMessageAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./modules/database/index.js', () => ({
  appConfigDb: { get: vi.fn(() => null) },
}));

vi.mock('./tap.js', () => ({
  getTapSession: vi.fn(() => null),
}));

vi.mock('./services/notification-orchestrator.js', () => ({
  createNotificationEvent: vi.fn(() => ({})),
  notifyRunFailed: vi.fn(),
  notifyRunStopped: vi.fn(),
  notifyUserIfEnabled: vi.fn(),
}));

vi.mock('./providers/claude/adapter.js', () => ({
  claudeAdapter: {
    normalizeMessage: vi.fn((msg) => {
      // Minimal normalization: produce one text message from assistant messages
      if (msg.type === 'assistant' && msg.message?.content) {
        const text = msg.message.content.find(c => c.type === 'text')?.text ?? '';
        return [{
          kind: 'text', role: 'assistant', content: text,
          sessionId: msg.session_id ?? null, provider: 'claude',
        }];
      }
      if (msg.type === 'result') {
        return [{ kind: 'result', role: 'assistant', content: '', sessionId: msg.session_id ?? null, provider: 'claude' }];
      }
      return [];
    }),
  },
}));

// ---- Helpers ----

async function* makeAsyncIterable(items) {
  for (const item of items) yield item;
}

const FAKE_SESSION = 'test-session-abc-123';
const MAX_STALL_RETRIES = 3;

function makeWs() {
  const sent = [];
  const ws = {
    send: vi.fn((raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      sent.push(msg);
    }),
    userId: null,
    setSessionId: vi.fn(),
  };
  return { ws, sent };
}

function makeSyntheticIdleTimeoutMessage() {
  return {
    type: 'assistant',
    error: 'unknown',
    session_id: FAKE_SESSION,
    uuid: `msg-err-${Math.random()}`,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      content: [{ type: 'text', text: 'API Error: Stream idle timeout - partial response received' }],
    },
  };
}

function makeResultMessage() {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Task completed.',
    session_id: FAKE_SESSION,
    uuid: 'result-1',
    modelUsage: {},
  };
}

// ---- Tests ----

describe('queryClaudeSDK — stream idle timeout retry', () => {
  let queryClaudeSDK;
  let mockQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdkMod.query;
    const mod = await import('./claude-sdk.js');
    queryClaudeSDK = mod.queryClaudeSDK;
  });

  it('retries when SDK emits a synthetic stream idle timeout error (error: unknown, model: <synthetic>)', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeAsyncIterable([
          {
            type: 'assistant',
            session_id: FAKE_SESSION,
            uuid: 'msg-1',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'I will help you with that.' }],
            },
          },
          makeSyntheticIdleTimeoutMessage(),
        ]);
      }
      // Retry call: completes normally
      return makeAsyncIterable([makeResultMessage()]);
    });

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    // query must have been called at least twice (original + retry)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Retry call must use resume with the captured session ID
    const retryCallArgs = mockQuery.mock.calls[1][0];
    expect(retryCallArgs.options.resume).toBe(FAKE_SESSION);

    // Frontend should see stall_retry status, not a raw error
    const stallMsg = sent.find(m => m.kind === 'status' && m.text === 'stall_retry');
    expect(stallMsg).toBeDefined();

    // Frontend should NOT see kind: 'error' (error was retried away)
    expect(sent.find(m => m.kind === 'error')).toBeUndefined();

    // Frontend should see kind: 'complete' with exitCode 0 (success)
    const completeMsg = sent.find(m => m.kind === 'complete');
    expect(completeMsg).toBeDefined();
    expect(completeMsg.exitCode).toBe(0);
  });

  it('does NOT retry a normal assistant message without error field', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      return makeAsyncIterable([
        {
          type: 'assistant',
          session_id: FAKE_SESSION,
          uuid: 'msg-ok',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'All done.' }],
          },
        },
        makeResultMessage(),
      ]);
    });

    const { ws } = makeWs();
    await queryClaudeSDK('hello', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);
    expect(callCount).toBe(1);
  });

  it('does NOT retry error: unknown without model: <synthetic> (non-retriable error)', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      // error: 'unknown' but NOT model: '<synthetic>' — should not be treated as idle timeout
      return makeAsyncIterable([
        {
          type: 'assistant',
          error: 'unknown',
          session_id: FAKE_SESSION,
          uuid: 'msg-err',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6', // real model, not <synthetic>
            content: [{ type: 'text', text: 'Something went wrong.' }],
          },
        },
      ]);
    });

    const { ws, sent } = makeWs();
    await queryClaudeSDK('hello', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    // Should NOT retry — real model with error: 'unknown' is not a synthetic idle timeout
    expect(callCount).toBe(1);
    // The error message should be forwarded to the frontend as-is
    const textMsg = sent.find(m => m.kind === 'text');
    expect(textMsg?.content).toContain('Something went wrong.');
  });

  it('exhausts retries and sends error message without a misleading complete event', async () => {
    // Every call returns an idle-timeout error — exhausts all MAX_STALL_RETRIES slots
    mockQuery.mockImplementation(() =>
      makeAsyncIterable([makeSyntheticIdleTimeoutMessage()])
    );

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    // query called MAX_STALL_RETRIES + 1 times (initial + retries)
    expect(mockQuery).toHaveBeenCalledTimes(MAX_STALL_RETRIES + 1);

    // Each retry emits a stall_retry status
    const stallMsgs = sent.filter(m => m.kind === 'status' && m.text === 'stall_retry');
    expect(stallMsgs).toHaveLength(MAX_STALL_RETRIES);

    // After exhaustion: frontend sees exactly one error message
    const errorMsgs = sent.filter(m => m.kind === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].content).toMatch(/timeout/i);

    // After exhaustion: frontend must NOT receive a misleading exitCode: 0 complete
    expect(sent.find(m => m.kind === 'complete')).toBeUndefined();
  });
});

describe('queryClaudeSDK — executable path mapping', () => {
  let queryClaudeSDK;
  let mockQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdkMod.query;
    const mod = await import('./claude-sdk.js');
    queryClaudeSDK = mod.queryClaudeSDK;
  });

  it('does not force pathToClaudeCodeExecutable when CLAUDE_CLI_PATH is unset', async () => {
    const previousCliPath = process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;

    try {
      mockQuery.mockImplementation(() => makeAsyncIterable([makeResultMessage()]));

      const { ws } = makeWs();
      await queryClaudeSDK('hello', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

      const firstCall = mockQuery.mock.calls[0]?.[0];
      expect(firstCall).toBeDefined();
      expect(firstCall.options.pathToClaudeCodeExecutable).toBeUndefined();
    } finally {
      if (previousCliPath === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = previousCliPath;
      }
    }
  });

  it('uses CLAUDE_CLI_PATH when explicitly configured', async () => {
    const previousCliPath = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = '/custom/bin/claude';

    try {
      mockQuery.mockImplementation(() => makeAsyncIterable([makeResultMessage()]));

      const { ws } = makeWs();
      await queryClaudeSDK('hello', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

      const firstCall = mockQuery.mock.calls[0]?.[0];
      expect(firstCall).toBeDefined();
      expect(firstCall.options.pathToClaudeCodeExecutable).toBe('/custom/bin/claude');
    } finally {
      if (previousCliPath === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = previousCliPath;
      }
    }
  });
});

describe('queryClaudeSDK — result-based completion', () => {
  let queryClaudeSDK;
  let mockQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdkMod.query;
    const mod = await import('./claude-sdk.js');
    queryClaudeSDK = mod.queryClaudeSDK;
  });

  function makeAssistantMessage(text) {
    return {
      type: 'assistant',
      session_id: FAKE_SESSION,
      uuid: `msg-${Math.random()}`,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text }],
      },
    };
  }

  it('treats a stream that drains without a result message as a failure (no complete)', async () => {
    mockQuery.mockImplementation(() => makeAsyncIterable([
      makeAssistantMessage('Working on it.'),
    ]));

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    // A missing result means "iterator drained", not "turn completed" — no retry loop spin
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const errorMsgs = sent.filter(m => m.kind === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].content).toMatch(/without reporting a result/i);

    // Must not report a misleading success
    expect(sent.find(m => m.kind === 'complete')).toBeUndefined();
  });

  it('treats an error-subtype result as a failure and surfaces its errors[]', async () => {
    mockQuery.mockImplementation(() => makeAsyncIterable([
      makeAssistantMessage('Working on it.'),
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 20,
        terminal_reason: 'max_turns',
        errors: ['Reached maximum number of turns (20)'],
        session_id: FAKE_SESSION,
        uuid: 'result-err',
        modelUsage: {},
      },
    ]));

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    const errorMsgs = sent.filter(m => m.kind === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].content).toContain('Reached maximum number of turns');

    expect(sent.find(m => m.kind === 'complete')).toBeUndefined();
  });

  it('treats a success-subtype result with is_error as a failure', async () => {
    mockQuery.mockImplementation(() => makeAsyncIterable([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'API Error: overloaded',
        session_id: FAKE_SESSION,
        uuid: 'result-apierr',
        modelUsage: {},
      },
    ]));

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    const errorMsgs = sent.filter(m => m.kind === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].content).toContain('API Error: overloaded');

    expect(sent.find(m => m.kind === 'complete')).toBeUndefined();
  });
});

describe('queryClaudeSDK — SDK-wrapped stream errors', () => {
  let queryClaudeSDK;
  let mockQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdkMod.query;
    const mod = await import('./claude-sdk.js');
    queryClaudeSDK = mod.queryClaudeSDK;
  });

  // An abnormal CLI exit surfaces as a thrown `Error` carrying the last error-result
  // text — the iterator rejects instead of yielding a result message.
  function makeThrowingStream(errorMessage) {
    return (async function* () {
      yield {
        type: 'assistant',
        session_id: FAKE_SESSION,
        uuid: 'msg-partial',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'partial response' }],
        },
      };
      throw new Error(errorMessage);
    })();
  }

  const SDK_STREAM_ERROR =
    'Claude Code returned an error result: API Error: Stream error: error decoding response body';

  it('retries the SDK-wrapped stream error, then succeeds', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeThrowingStream(SDK_STREAM_ERROR);
      return makeAsyncIterable([makeResultMessage()]);
    });

    const { ws, sent } = makeWs();
    await queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);

    expect(callCount).toBe(2);
    expect(mockQuery.mock.calls[1][0].options.resume).toBe(FAKE_SESSION);

    expect(sent.find(m => m.kind === 'status' && m.text === 'stall_retry')).toBeDefined();
    expect(sent.find(m => m.kind === 'error')).toBeUndefined();
    expect(sent.find(m => m.kind === 'complete')?.exitCode).toBe(0);
  });

  it('gives up after MAX_STALL_RETRIES and surfaces the error once (no complete)', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      return makeThrowingStream(SDK_STREAM_ERROR);
    });

    const { ws, sent } = makeWs();
    await expect(
      queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws)
    ).rejects.toThrow(/error decoding response body/);

    // original attempt + MAX_STALL_RETRIES retries
    expect(callCount).toBe(MAX_STALL_RETRIES + 1);

    const errorMsgs = sent.filter(m => m.kind === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].content).toMatch(/error decoding response body/);
    expect(sent.find(m => m.kind === 'complete')).toBeUndefined();
  });

  it('does NOT retry a terminal SDK-wrapped error (e.g. max turns)', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      return makeThrowingStream('Claude Code returned an error result: Reached maximum number of turns (20)');
    });

    const { ws, sent } = makeWs();
    await expect(
      queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws)
    ).rejects.toThrow(/maximum number of turns/);

    expect(callCount).toBe(1);
    expect(sent.filter(m => m.kind === 'error')).toHaveLength(1);
  });
});

describe('queryClaudeSDK — idle session reaper', () => {
  let queryClaudeSDK;
  let isClaudeSDKSessionActive;
  let reapIdleSessions;
  let mockQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdkMod.query;
    const mod = await import('./claude-sdk.js');
    queryClaudeSDK = mod.queryClaudeSDK;
    isClaudeSDKSessionActive = mod.isClaudeSDKSessionActive;
    reapIdleSessions = mod.reapIdleSessions;
  });

  // A stream that yields at most one message and then never settles — the
  // wedged-CLI case the CLI-side stream watchdog cannot catch.
  function makeWedgedStream(firstMessage = null) {
    let delivered = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (firstMessage && !delivered) {
          delivered = true;
          return Promise.resolve({ value: firstMessage, done: false });
        }
        return new Promise(() => {});
      },
      return() { return new Promise(() => {}); },
    };
  }

  it('force-closes a session whose stream never settles and notifies the client', async () => {
    mockQuery.mockImplementation(() => makeWedgedStream());

    const { ws, sent } = makeWs();
    const pending = queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);
    pending.catch(() => {});

    await vi.waitFor(() => {
      expect(isClaudeSDKSessionActive(FAKE_SESSION)).toBe(true);
    });

    // Simulate the lease expiring (60s of silence).
    const reaped = reapIdleSessions(Date.now() + 60_000, 60_000);

    expect(reaped).toEqual([FAKE_SESSION]);
    // isClaudeSDKSessionActive returns undefined (not false) for an unknown id.
    expect(isClaudeSDKSessionActive(FAKE_SESSION)).toBeFalsy();

    const complete = sent.find(m => m.kind === 'complete');
    expect(complete).toBeDefined();
    expect(complete.aborted).toBe(true);
    expect(complete.reason).toBe('idle_timeout');
    expect(complete.sessionId).toBe(FAKE_SESSION);
  });

  it('does not reap a session that is still producing messages', async () => {
    mockQuery.mockImplementation(() => makeWedgedStream({
      type: 'assistant',
      session_id: FAKE_SESSION,
      uuid: 'msg-1',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'working' }],
      },
    }));

    const { ws, sent } = makeWs();
    const pending = queryClaudeSDK('do something', { sessionId: FAKE_SESSION, cwd: '/tmp' }, ws);
    pending.catch(() => {});

    await vi.waitFor(() => {
      expect(sent.some(m => m.kind === 'text' && m.content === 'working')).toBe(true);
    });

    const reaped = reapIdleSessions(Date.now(), 60_000);

    expect(reaped).toEqual([]);
    expect(isClaudeSDKSessionActive(FAKE_SESSION)).toBe(true);
  });
});

describe('mapCliOptionsToSDK — §6.2 soft built-in Cron preference', () => {
  let mapCliOptionsToSDK;
  let savedBlockBuiltinCron;
  let savedScheduleTools;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    savedBlockBuiltinCron = process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON;
    savedScheduleTools = process.env.SCHEDULED_TASKS_TOOLS;
    delete process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON;
    delete process.env.SCHEDULED_TASKS_TOOLS;

    const mod = await import('./claude-sdk.js');
    mapCliOptionsToSDK = mod.mapCliOptionsToSDK;
  });

  afterEach(() => {
    if (savedBlockBuiltinCron === undefined) delete process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON;
    else process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = savedBlockBuiltinCron;

    if (savedScheduleTools === undefined) delete process.env.SCHEDULED_TASKS_TOOLS;
    else process.env.SCHEDULED_TASKS_TOOLS = savedScheduleTools;
  });

  it('leaves the built-in Cron tools available by default (soft preference)', () => {
    const sdkOptions = mapCliOptionsToSDK({});

    expect(sdkOptions.disallowedTools).toEqual([]);
  });

  it('passes the user-configured deny list through untouched', () => {
    const sdkOptions = mapCliOptionsToSDK({
      toolsSettings: { allowedTools: [], disallowedTools: ['Bash(rm:*)', 'CronCreate'] },
    });

    expect(sdkOptions.disallowedTools).toEqual(['Bash(rm:*)', 'CronCreate']);
  });

  it('blocks them only when SCHEDULED_TASKS_BLOCK_BUILTIN_CRON=1, without duplicating', () => {
    process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = '1';

    const sdkOptions = mapCliOptionsToSDK({
      toolsSettings: { disallowedTools: ['Bash(rm:*)', 'CronCreate'] },
    });

    expect(sdkOptions.disallowedTools).toEqual(['Bash(rm:*)', 'CronCreate', 'CronList', 'CronDelete']);
  });

  it('accepts true/yes/on for the block flag', () => {
    process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = 'yes';

    expect(mapCliOptionsToSDK({}).disallowedTools).toEqual(['CronCreate', 'CronList', 'CronDelete']);
  });

  it('never blocks them when SCHEDULED_TASKS_TOOLS=0, even with the flag set', () => {
    process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = '1';
    process.env.SCHEDULED_TASKS_TOOLS = '0';

    const sdkOptions = mapCliOptionsToSDK({
      toolsSettings: { disallowedTools: ['Bash(rm:*)'] },
    });

    expect(sdkOptions.disallowedTools).toEqual(['Bash(rm:*)']);
  });

  it('still pre-allows our own schedule tools by default', () => {
    const sdkOptions = mapCliOptionsToSDK({});
    const allowed = sdkOptions.allowedTools || [];

    expect(allowed).toContain('mcp__internal__schedule_create');
  });
});
