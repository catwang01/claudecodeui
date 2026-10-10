/**
 * Test suite for Copilot adapter fetchHistory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock database
const mockSessionsDb = {
  getSessionById: vi.fn(),
};

vi.mock('../../modules/database/index.js', () => ({
  sessionsDb: mockSessionsDb,
}));

// Import after mocking
const { copilotAdapter } = await import('./adapter.js');

describe('Copilot Adapter - fetchHistory', () => {
  const testSessionId = 'test-session-123';
  const testJsonlPath = path.join(os.tmpdir(), 'test-copilot-events.jsonl');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup test file
    try {
      await fs.unlink(testJsonlPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  it('should return empty messages when session has no jsonl_path', async () => {
    mockSessionsDb.getSessionById.mockReturnValue({ session_id: testSessionId });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result).toEqual({
      messages: [],
      total: 0,
      hasMore: false,
      offset: 0,
      limit: undefined,
    });
  });

  it('should return empty messages when jsonl file does not exist', async () => {
    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: '/nonexistent/path/events.jsonl',
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result).toEqual({
      messages: [],
      total: 0,
      hasMore: false,
      offset: 0,
      limit: undefined,
    });
  });

  it('should parse user and assistant messages correctly', async () => {
    const events = [
      {
        type: 'session.start',
        timestamp: '2026-06-09T07:00:00.000Z',
        id: 'evt-1',
        data: { sessionId: testSessionId },
      },
      {
        type: 'user.message',
        timestamp: '2026-06-09T07:00:01.000Z',
        id: 'evt-2',
        data: { content: 'Hello, Copilot!' },
      },
      {
        type: 'assistant.message',
        timestamp: '2026-06-09T07:00:02.000Z',
        id: 'evt-3',
        data: { content: 'Hello! How can I help you?' },
      },
    ];

    const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(testJsonlPath, jsonlContent, 'utf-8');

    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result.messages).toHaveLength(2); // user + assistant (session.start is ignored)
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);

    // Check user message
    expect(result.messages[0]).toMatchObject({
      id: 'evt-2',
      kind: 'text',
      role: 'user',
      content: 'Hello, Copilot!',
      provider: 'copilot',
    });

    // Check assistant message
    expect(result.messages[1]).toMatchObject({
      id: 'evt-3',
      kind: 'text',
      role: 'assistant',
      content: 'Hello! How can I help you?',
      provider: 'copilot',
    });
  });

  it('should parse tool use and tool result events', async () => {
    const events = [
      {
        type: 'tool.use',
        timestamp: '2026-06-09T07:00:03.000Z',
        id: 'evt-4',
        data: {
          name: 'read_file',
          input: { path: '/test/file.txt' },
          id: 'tool-1',
        },
      },
      {
        type: 'tool.result',
        timestamp: '2026-06-09T07:00:04.000Z',
        id: 'evt-5',
        data: {
          tool_use_id: 'tool-1',
          content: 'File content here',
          is_error: false,
        },
      },
    ];

    const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(testJsonlPath, jsonlContent, 'utf-8');

    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result.messages).toHaveLength(2);

    // Check tool use
    expect(result.messages[0]).toMatchObject({
      id: 'evt-4',
      kind: 'tool_use',
      toolName: 'read_file',
      toolId: 'tool-1',
      provider: 'copilot',
    });
    expect(result.messages[0].toolInput).toEqual({ path: '/test/file.txt' });

    // Check tool result
    expect(result.messages[1]).toMatchObject({
      id: 'evt-5',
      kind: 'tool_result',
      toolId: 'tool-1',
      content: 'File content here',
      isError: false,
      provider: 'copilot',
    });
  });

  it('restores CloudCLI artifact cards from managed Copilot history', async () => {
    const events = [
      {
        type: 'cloudcli.message',
        timestamp: '2026-06-09T07:00:05.000Z',
        id: 'download-card',
        message: {
          kind: 'file_download',
          filename: 'report.html',
          filepath: 'C:\\reports\\report.html',
          downloadUrl: 'https://attacker.example/steal-token',
          fileSize: 42,
        },
      },
      {
        type: 'cloudcli.message',
        timestamp: '2026-06-09T07:00:06.000Z',
        id: 'image-card',
        message: {
          kind: 'image_display',
          filename: 'chart.png',
          filepath: 'C:\\images\\chart.png',
          imageUrl: 'https://attacker.example/steal-token',
          fileSize: 84,
          mimeType: 'image/png',
        },
      },
    ];
    await fs.writeFile(testJsonlPath, events.map((event) => JSON.stringify(event)).join('\n'), 'utf-8');
    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      kind: 'file_download',
      provider: 'copilot',
      filename: 'report.html',
      downloadUrl: `/api/download?filepath=${encodeURIComponent('C:\\reports\\report.html')}`,
    });
    expect(result.messages[1]).toMatchObject({
      kind: 'image_display',
      provider: 'copilot',
      filename: 'chart.png',
      imageUrl: `/api/image?filepath=${encodeURIComponent('C:\\images\\chart.png')}`,
      mimeType: 'image/png',
    });
  });

  it('does not restore active content as an image card', async () => {
    await fs.writeFile(testJsonlPath, [
      {
        type: 'cloudcli.message',
        id: 'unsafe-image-card',
        message: {
          kind: 'image_display',
          filename: 'preview.svg',
          filepath: 'C:\\images\\preview.svg',
          imageUrl: '/api/image?filepath=unsafe',
          mimeType: 'image/svg+xml',
        },
      },
      {
        type: 'cloudcli.message',
        id: 'network-image-card',
        message: {
          kind: 'image_display',
          filename: 'preview.png',
          filepath: '\\\\attacker.example\\share\\preview.png',
          imageUrl: '/api/image?filepath=unsafe',
          mimeType: 'image/png',
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'), 'utf-8');
    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    expect(result.messages).toEqual([]);
  });

  it('should support pagination with limit and offset', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      type: 'user.message',
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      id: `evt-${i}`,
      data: { content: `Message ${i}` },
    }));

    const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(testJsonlPath, jsonlContent, 'utf-8');

    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    // Get first page (5 messages)
    const page1 = await copilotAdapter.fetchHistory(testSessionId, {
      limit: 5,
      offset: 0,
    });

    expect(page1.messages).toHaveLength(5);
    expect(page1.total).toBe(10);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages[0].content).toBe('Message 0');
    expect(page1.messages[4].content).toBe('Message 4');

    // Get second page
    const page2 = await copilotAdapter.fetchHistory(testSessionId, {
      limit: 5,
      offset: 5,
    });

    expect(page2.messages).toHaveLength(5);
    expect(page2.total).toBe(10);
    expect(page2.hasMore).toBe(false);
    expect(page2.messages[0].content).toBe('Message 5');
    expect(page2.messages[4].content).toBe('Message 9');
  });

  it('should handle malformed JSON lines gracefully', async () => {
    const jsonlContent = [
      JSON.stringify({ type: 'user.message', id: '1', timestamp: '2026-06-09T07:00:00.000Z', data: { content: 'Good message' } }),
      'invalid json {{{',
      JSON.stringify({ type: 'assistant.message', id: '2', timestamp: '2026-06-09T07:00:01.000Z', data: { content: 'Another good message' } }),
    ].join('\n');

    await fs.writeFile(testJsonlPath, jsonlContent, 'utf-8');

    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    // Should skip the malformed line but parse the valid ones
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('Good message');
    expect(result.messages[1].content).toBe('Another good message');
  });

  it('should ignore irrelevant event types', async () => {
    const events = [
      { type: 'session.start', timestamp: '2026-06-09T07:00:00.000Z', id: 'evt-1', data: {} },
      { type: 'assistant.turn_start', timestamp: '2026-06-09T07:00:01.000Z', id: 'evt-2', data: {} },
      { type: 'system.message', timestamp: '2026-06-09T07:00:02.000Z', id: 'evt-3', data: { content: 'System message' } },
      { type: 'user.message', timestamp: '2026-06-09T07:00:03.000Z', id: 'evt-4', data: { content: 'User message' } },
    ];

    const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(testJsonlPath, jsonlContent, 'utf-8');

    mockSessionsDb.getSessionById.mockReturnValue({
      session_id: testSessionId,
      jsonl_path: testJsonlPath,
    });

    const result = await copilotAdapter.fetchHistory(testSessionId);

    // Should only parse the user.message, ignore others
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('User message');
  });
});
