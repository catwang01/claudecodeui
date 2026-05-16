import { scanStateDb } from '@/modules/database/index.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';

export const sessionSynchronizerService = {
  async synchronizeSessions(): Promise<void> {
    const lastScanAt = scanStateDb.getLastScannedAt();

    for (const synchronizer of ALL_SYNCHRONIZERS) {
      try {
        await synchronizer.synchronize(lastScanAt);
      } catch (err) {
        console.error(`[session-sync] ${synchronizer.provider} synchronize failed:`, err);
      }
    }

    scanStateDb.updateLastScannedAt(new Date());
  },

  async synchronizeProviderFile(provider: string, filePath: string): Promise<string | null> {
    const synchronizer = ALL_SYNCHRONIZERS.find(s => s.provider === provider);
    if (!synchronizer) return null;

    try {
      return await synchronizer.synchronizeFile(filePath);
    } catch (err) {
      console.error(`[session-sync] ${provider} synchronizeFile failed for ${filePath}:`, err);
      return null;
    }
  },
};
