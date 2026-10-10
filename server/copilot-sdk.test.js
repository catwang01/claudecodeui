import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotClient } from '@github/copilot-sdk';
import { sessionsDb } from './database/db.js';

const summaryRefreshMocks = vi.hoisted(() => ({
  waitForCopilotSessionSummary: vi.fn(),
  getProjects: vi.fn(),
}));

vi.mock('./modules/providers/list/copilot/copilot-session-synchronizer.provider.js', () => ({
  waitForCopilotSessionSummary: summaryRefreshMocks.waitForCopilotSessionSummary,
}));

vi.mock('./projects.js', () => ({
  getProjects: summaryRefreshMocks.getProjects,
}));

import * as copilotSdk from './copilot-sdk.js';

const {
  buildCopilotAttachments,
  buildCopilotForkPrompt,
  getCopilotEventsPath,
  normalizeCopilotModels,
  queryCopilotSDK,
} = copilotSdk;

const tempPaths = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe('normalizeCopilotModels', () => {
  it('maps SDK model metadata to unique selector options', () => {
    expect(normalizeCopilotModels([
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.5', name: 'Duplicate' },
      { id: 'claude-sonnet-4.6', name: '' },
      { name: 'Missing ID' },
    ])).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6' },
    ]);
  });

  describe('refreshCopilotSessionSummary', () => {
    it('broadcasts updated projects after the completed session gets a native summary', async () => {
      summaryRefreshMocks.waitForCopilotSessionSummary.mockResolvedValue('cloud-session');
      summaryRefreshMocks.getProjects.mockResolvedValue([{ path: 'C:\\repo' }]);
      const messages = [];

      const refreshed = await copilotSdk.refreshCopilotSessionSummary(
        'native-session',
        (message) => messages.push(message)
      );

      expect(refreshed).toBe(true);
      expect(messages).toEqual([{
        type: 'projects_updated',
        projects: [{ path: 'C:\\repo' }],
        timestamp: expect.any(String),
        changeType: 'change',
        watchProvider: 'copilot',
        updatedSessionIds: ['cloud-session'],
        batched: false,
      }]);
    });
  });
});

describe('resolveCopilotSessionId', () => {
  it('uses the native provider session ID for a managed Copilot session', () => {
    vi.spyOn(sessionsDb, 'getSessionById').mockReturnValue({
      session_id: 'managed-session',
      provider: 'copilot',
      provider_session_id: 'native-session',
    });

    expect(copilotSdk.resolveCopilotSessionId('managed-session')).toBe('native-session');
  });

  it('keeps the requested session ID when no native mapping exists', () => {
    vi.spyOn(sessionsDb, 'getSessionById').mockReturnValue(null);

    expect(copilotSdk.resolveCopilotSessionId('unmapped-session')).toBe('unmapped-session');
  });
});

describe('normalizeLegacyCopilotEvents', () => {
  it('normalizes a cancelled self-paced schedule for current resume validation', () => {
    const content = [
      JSON.stringify({
        type: 'session.schedule_created',
        data: {
          id: 1,
          prompt: 'Continue later',
          recurring: true,
          displayPrompt: 'Continue later',
          selfPaced: true,
          origin: 'user',
        },
        id: 'created',
        timestamp: '2026-09-30T03:25:46.010Z',
        parentId: 'previous',
      }),
      JSON.stringify({
        type: 'session.schedule_cancelled',
        data: { id: 1 },
        id: 'cancelled',
        timestamp: '2026-09-30T05:18:19.476Z',
        parentId: 'created',
      }),
    ].join('\n');

    const result = copilotSdk.normalizeLegacyCopilotEvents(content);
    const migrated = JSON.parse(result.content.split('\n')[0]);

    expect(result.changed).toBe(true);
    expect(migrated.data).toEqual({
      id: 1,
      intervalMs: 1,
      prompt: 'Continue later',
      recurring: true,
      displayPrompt: 'Continue later',
    });
  });

  it('does not change an active self-paced schedule', () => {
    const content = JSON.stringify({
      type: 'session.schedule_created',
      data: {
        id: 1,
        prompt: 'Continue later',
        recurring: true,
        selfPaced: true,
        origin: 'user',
      },
    });

    expect(copilotSdk.normalizeLegacyCopilotEvents(content)).toEqual({
      content,
      changed: false,
    });
  });

  it('removes legacy nullable and unsupported skill metadata', () => {
    const content = JSON.stringify({
      type: 'skill.invoked',
      data: {
        name: 'web-search',
        path: 'C:\\skills\\web-search\\SKILL.md',
        content: '# Web Search',
        allowedTools: [],
        source: 'personal-copilot',
        pluginName: null,
        pluginVersion: null,
        description: 'Search the web',
        trigger: 'agent-invoked',
        model: 'gpt-5.6-sol',
        invokedAtTurn: 42,
      },
    });

    const result = copilotSdk.normalizeLegacyCopilotEvents(content);

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.content).data).toEqual({
      name: 'web-search',
      path: 'C:\\skills\\web-search\\SKILL.md',
      content: '# Web Search',
      allowedTools: [],
      source: 'personal-copilot',
      description: 'Search the web',
      trigger: 'agent-invoked',
    });
  });

  it('backs up and migrates a legacy events file before resume', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-legacy-events-'));
    tempPaths.push(tempDir);
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const content = [
      JSON.stringify({
        type: 'session.schedule_created',
        data: { id: 1, prompt: 'Continue later', selfPaced: true, origin: 'user' },
      }),
      JSON.stringify({ type: 'session.schedule_cancelled', data: { id: 1 } }),
    ].join('\n');
    fs.writeFileSync(eventsPath, content, 'utf8');

    const changed = copilotSdk.migrateLegacyCopilotEventsFile(eventsPath);

    expect(changed).toBe(true);
    expect(fs.readFileSync(`${eventsPath}.cloudcli-backup`, 'utf8')).toBe(content);
    expect(JSON.parse(fs.readFileSync(eventsPath, 'utf8').split('\n')[0]).data).toEqual({
      id: 1,
      intervalMs: 1,
      prompt: 'Continue later',
    });
  });
});

describe('buildCopilotForkPrompt', () => {
  it('imports forked user and assistant history before the current request', () => {
    const history = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Inspect the histogram sender.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'The sender is in metrics.cc.' }] },
      }),
    ].join('\n');

    const prompt = buildCopilotForkPrompt(history, 'Now compare its send frequency.');

    expect(prompt).toContain('User:\nInspect the histogram sender.');
    expect(prompt).toContain('Assistant:\nThe sender is in metrics.cc.');
    expect(prompt).toContain('<current_user_request>\nNow compare its send frequency.');
  });

  it('returns the original command when the fork has no usable history', () => {
    expect(buildCopilotForkPrompt('{"type":"progress"}', 'Continue')).toBe('Continue');
  });

  it('imports native Copilot event history', () => {
    const history = [
      JSON.stringify({
        type: 'user.message',
        data: { content: 'Inspect the native Copilot session.' },
      }),
      JSON.stringify({
        type: 'assistant.message',
        data: { content: 'The session is stored under .copilot.' },
      }),
    ].join('\n');

    const prompt = buildCopilotForkPrompt(history, 'Continue.');

    expect(prompt).toContain('User:\nInspect the native Copilot session.');
    expect(prompt).toContain('Assistant:\nThe session is stored under .copilot.');
  });

  it('keeps the newest history when the bootstrap size is capped', () => {
    const history = [
      JSON.stringify({ message: { role: 'user', content: 'old context' } }),
      JSON.stringify({ message: { role: 'assistant', content: 'new context' } }),
    ].join('\n');

    const prompt = buildCopilotForkPrompt(history, 'Continue', 11);

    expect(prompt).not.toContain('old context');
    expect(prompt).toContain('new context');
  });
});

describe('getCopilotEventsPath', () => {
  it('uses the native Copilot session-state directory', () => {
    const eventsPath = getCopilotEventsPath('native-session');

    expect(eventsPath).toBe(
      path.join(os.homedir(), '.copilot', 'session-state', 'native-session', 'events.jsonl')
    );
    expect(eventsPath).not.toContain(`${path.sep}.claude${path.sep}`);
  });
});

describe('queryCopilotSDK native persistence', () => {
  it('registers native Copilot events without creating a Claude transcript', async () => {
    const sessionId = `native-${Date.now()}`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-native-session-'));
    tempPaths.push(cwd);
    const encodedCwd = path.resolve(cwd)
      .toLowerCase()
      .replace(/[^a-zA-Z0-9]/g, '-');
    const legacyClaudePath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      encodedCwd,
      `${sessionId}.jsonl`
    );
    const eventHandlers = new Map();
    const fakeSession = {
      sessionId,
      on: vi.fn((eventNameOrHandler, handler) => {
        if (typeof eventNameOrHandler === 'function') {
          return () => {};
        }
        eventHandlers.set(eventNameOrHandler, handler);
        return () => eventHandlers.delete(eventNameOrHandler);
      }),
      send: vi.fn(async () => {
        setTimeout(() => eventHandlers.get('session.idle')?.({
          type: 'session.idle',
          data: {},
        }), 0);
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(CopilotClient.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(CopilotClient.prototype, 'createSession').mockResolvedValue(fakeSession);
    const createSessionSpy = vi.spyOn(sessionsDb, 'createSession').mockReturnValue(sessionId);
    const writer = { send: vi.fn() };

    await queryCopilotSDK('Use the native Copilot session.', { cwd }, writer);

    expect(createSessionSpy).toHaveBeenCalledWith(
      sessionId,
      'copilot',
      cwd,
      null,
      null,
      null,
      path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl'),
      sessionId
    );
    expect(fs.existsSync(legacyClaudePath)).toBe(false);
  });
});

describe('buildCopilotAttachments', () => {
  it('converts uploaded images into SDK blob attachments', () => {
    expect(buildCopilotAttachments({
      images: [{
        name: 'diagram.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aGVsbG8=',
      }],
    })).toEqual([{
      type: 'blob',
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      displayName: 'diagram.png',
    }]);
  });

  it('attaches uploaded and referenced files while ignoring directories', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-attachments-'));
    tempPaths.push(tempDir);
    const uploadedPath = path.join(tempDir, 'uploaded.txt');
    const referencedPath = path.join(tempDir, 'referenced.ts');
    fs.writeFileSync(uploadedPath, 'uploaded');
    fs.writeFileSync(referencedPath, 'referenced');

    expect(buildCopilotAttachments({
      files: [{ name: 'original.txt', path: uploadedPath }],
      references: [referencedPath, tempDir, referencedPath],
    })).toEqual([
      { type: 'file', path: uploadedPath, displayName: 'original.txt' },
      { type: 'file', path: referencedPath, displayName: 'referenced.ts' },
    ]);
  });
});

describe('Copilot internal artifact tools', () => {
  it('registers download and image tools on every session', () => {
    const config = copilotSdk.buildCopilotSessionConfig({ model: 'gpt-5.5' });

    expect(config.model).toBe('gpt-5.5');
    expect(config.tools.map((tool) => tool.name)).toEqual(['download', 'image']);
    expect(config.tools.every((tool) => tool.skipPermission === true)).toBe(true);
  });

  it('returns download metadata for an existing file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-download-tool-'));
    tempPaths.push(tempDir);
    const filepath = path.join(tempDir, 'report.html');
    fs.writeFileSync(filepath, '<h1>Report</h1>');
    const downloadTool = copilotSdk.createCopilotInternalTools().find((tool) => tool.name === 'download');

    const result = await downloadTool.handler({ filepath });

    expect(JSON.parse(result)).toEqual({
      artifactKind: 'download',
      filepath,
      filename: 'report.html',
      downloadUrl: `/api/download?filepath=${encodeURIComponent(filepath)}`,
      fileSize: 15,
      message: 'File "report.html" is ready. The UI will display a download button.',
    });
  });

  it('returns image metadata with the correct MIME type', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-image-tool-'));
    tempPaths.push(tempDir);
    const filepath = path.join(tempDir, 'chart.webp');
    fs.writeFileSync(filepath, 'webp-image');
    const imageTool = copilotSdk.createCopilotInternalTools().find((tool) => tool.name === 'image');

    const result = await imageTool.handler({ filepath });

    expect(JSON.parse(result)).toEqual({
      artifactKind: 'image',
      filepath,
      filename: 'chart.webp',
      imageUrl: `/api/image?filepath=${encodeURIComponent(filepath)}`,
      fileSize: 10,
      mimeType: 'image/webp',
      message: 'Image "chart.webp" is ready. The UI will display it inline.',
    });
  });

  it('rejects directories and active image formats', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-artifact-validation-'));
    tempPaths.push(tempDir);
    const svgPath = path.join(tempDir, 'active.svg');
    fs.writeFileSync(svgPath, '<svg><script>alert(1)</script></svg>');
    const tools = copilotSdk.createCopilotInternalTools();

    await expect(tools.find((tool) => tool.name === 'download').handler({
      filepath: tempDir,
    })).rejects.toThrow('not a regular file');
    await expect(tools.find((tool) => tool.name === 'image').handler({
      filepath: svgPath,
    })).rejects.toThrow('Unsupported image format');
  });

  it('rejects network paths before accessing the filesystem', async () => {
    const tools = copilotSdk.createCopilotInternalTools();

    await expect(tools.find((tool) => tool.name === 'download').handler({
      filepath: '\\\\attacker.example\\share\\report.html',
    })).rejects.toThrow('Network artifact paths are not allowed');
    await expect(tools.find((tool) => tool.name === 'image').handler({
      filepath: '\\\\attacker.example\\share\\image.png',
    })).rejects.toThrow('Network artifact paths are not allowed');
  });

  it('converts internal tool results into artifact cards only for matching tool calls', () => {
    const pendingTools = new Map([
      ['download-call', 'download'],
      ['image-call', 'image'],
    ]);

    expect(copilotSdk.buildCopilotArtifactMessage({
      toolCallId: 'download-call',
      content: JSON.stringify({
        artifactKind: 'download',
        filepath: 'C:\\reports\\report.html',
        filename: 'report.html',
        downloadUrl: '/api/download?filepath=report.html',
        fileSize: 42,
      }),
    }, pendingTools, 'session-1')).toMatchObject({
      kind: 'file_download',
      provider: 'copilot',
      sessionId: 'session-1',
      filename: 'report.html',
      fileSize: 42,
    });

    expect(copilotSdk.buildCopilotArtifactMessage({
      toolCallId: 'image-call',
      content: JSON.stringify({
        artifactKind: 'image',
        filepath: 'C:\\images\\chart.png',
        filename: 'chart.png',
        imageUrl: '/api/image?filepath=chart.png',
        fileSize: 84,
        mimeType: 'image/png',
      }),
    }, pendingTools, 'session-1')).toMatchObject({
      kind: 'image_display',
      provider: 'copilot',
      sessionId: 'session-1',
      filename: 'chart.png',
      mimeType: 'image/png',
    });

    expect(copilotSdk.buildCopilotArtifactMessage({
      toolCallId: 'other-call',
      content: '{}',
    }, pendingTools, 'session-1')).toBeNull();
  });
});
