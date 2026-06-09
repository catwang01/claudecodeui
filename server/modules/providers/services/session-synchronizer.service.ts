import { scanStateDb } from '@/modules/database/index.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';

export const sessionSynchronizerService = {
  async synchronizeSessions(): Promise<void> {
    console.log('[session-sync] Starting session synchronization for all providers...');
    const lastScanAt = scanStateDb.getLastScannedAt();
    console.log('[session-sync] Last scanned at:', lastScanAt);

    for (const synchronizer of ALL_SYNCHRONIZERS) {
      console.log(`[session-sync] Synchronizing provider: ${synchronizer.provider}`);
      try {
        const count = await synchronizer.synchronize(lastScanAt);
        console.log(`[session-sync] ${synchronizer.provider} synchronized ${count} sessions`);
      } catch (err) {
        console.error(`[session-sync] ${synchronizer.provider} synchronize failed:`, err);
      }
    }

    scanStateDb.updateLastScannedAt(new Date());
    console.log('[session-sync] All providers synchronized');
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
