import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/database/index.js', () => ({
  scanStateDb: {
    getLastScannedAt: vi.fn().mockReturnValue(null),
    updateLastScannedAt: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  ALL_SYNCHRONIZERS: [
    {
      provider: 'claude',
      watchPaths: [],
      synchronize: vi.fn().mockResolvedValue(3),
      synchronizeFile: vi.fn().mockResolvedValue('session-abc'),
    },
    {
      provider: 'cursor',
      watchPaths: [],
      synchronize: vi.fn().mockResolvedValue(1),
      synchronizeFile: vi.fn().mockResolvedValue(null),
    },
  ],
}));

import { scanStateDb } from '@/modules/database/index.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';
import { sessionSynchronizerService } from '../services/session-synchronizer.service.js';

describe('sessionSynchronizerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synchronizeSessions calls all providers with lastScanAt', async () => {
    const lastDate = new Date('2024-01-01');
    vi.mocked(scanStateDb.getLastScannedAt).mockReturnValue(lastDate);

    await sessionSynchronizerService.synchronizeSessions();

    expect(ALL_SYNCHRONIZERS[0].synchronize).toHaveBeenCalledWith(lastDate);
    expect(ALL_SYNCHRONIZERS[1].synchronize).toHaveBeenCalledWith(lastDate);
    expect(scanStateDb.updateLastScannedAt).toHaveBeenCalledOnce();
  });

  it('synchronizeSessions updates last scanned at even if one provider fails', async () => {
    vi.mocked((ALL_SYNCHRONIZERS[0] as any).synchronize).mockRejectedValue(new Error('oops'));

    await sessionSynchronizerService.synchronizeSessions();

    expect(scanStateDb.updateLastScannedAt).toHaveBeenCalledOnce();
  });

  it('synchronizeProviderFile delegates to correct provider', async () => {
    const result = await sessionSynchronizerService.synchronizeProviderFile('claude', '/path/to/file.jsonl');
    expect(result).toBe('session-abc');
    expect(ALL_SYNCHRONIZERS[0].synchronizeFile).toHaveBeenCalledWith('/path/to/file.jsonl');
  });

  it('synchronizeProviderFile returns null for unknown provider', async () => {
    const result = await sessionSynchronizerService.synchronizeProviderFile('unknown', '/path/to/file.jsonl');
    expect(result).toBeNull();
  });
});
