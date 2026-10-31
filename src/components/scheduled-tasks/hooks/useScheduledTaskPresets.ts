import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduledTasksApi } from '../api';
import type { CustomPresetInput, InstallPresetResult, Preset } from '../types';

/**
 * Loads the preset catalog for one project (section 10.7).
 *
 * `projectPath` scopes custom presets and is forwarded to install/enable calls;
 * an empty value lists every preset and lets the server decide. Every mutation
 * re-reads the list so the catalog stays the single source of truth.
 */
export function useScheduledTaskPresets(projectPath: string) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    try {
      const next = await scheduledTasksApi.listPresets({ projectPath: projectPath || undefined });
      if (requestId !== requestIdRef.current) return;
      setPresets(next);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installPreset = useCallback(
    async (id: string, options: { projectPath: string; enabled?: boolean }): Promise<InstallPresetResult> => {
      const result = await scheduledTasksApi.installPreset(id, options);
      await refresh();
      return result;
    },
    [refresh],
  );

  const setPresetEnabled = useCallback(
    async (id: string, enabled: boolean, options: { projectPath?: string } = {}): Promise<Preset> => {
      const result = enabled
        ? await scheduledTasksApi.enablePreset(id, options)
        : await scheduledTasksApi.disablePreset(id, options);
      await refresh();
      return result.preset;
    },
    [refresh],
  );

  const createPreset = useCallback(
    async (input: CustomPresetInput): Promise<Preset> => {
      const preset = await scheduledTasksApi.createPreset(input);
      await refresh();
      return preset;
    },
    [refresh],
  );

  const removePreset = useCallback(
    async (id: string, options: { purge?: boolean; projectPath?: string } = {}): Promise<number> => {
      const result = await scheduledTasksApi.removePreset(id, options);
      await refresh();
      return result.removedTasks;
    },
    [refresh],
  );

  return { presets, isLoading, error, refresh, installPreset, setPresetEnabled, createPreset, removePreset };
}
