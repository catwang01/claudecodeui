// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
