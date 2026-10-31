import { authenticatedFetch } from '../../utils/api';
import type { Project } from '../../types/app';
import type {
  CustomPresetInput,
  DeletePresetResult,
  InstallPresetResult,
  Preset,
  PresetEnabledResult,
  PresetPatch,
  ProjectOption,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  ScheduledTaskRun,
  TaskStatusFilter,
} from './types';

const BASE_URL = '/api/scheduled-tasks';
const PRESETS_URL = `${BASE_URL}/presets`;

export class ScheduledTasksApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ScheduledTasksApiError';
    this.status = status;
    this.code = code;
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const message = typeof record.error === 'string' && record.error ? record.error : `HTTP ${response.status}`;
    const code = typeof record.code === 'string' ? record.code : undefined;
    throw new ScheduledTasksApiError(message, response.status, code);
  }

  return payload as T;
}

function toApiStatus(status: TaskStatusFilter): 'active' | 'paused' | 'all' {
  if (status === 'enabled') return 'active';
  return status;
}

function extractProjects(payload: unknown): Project[] {
  if (Array.isArray(payload)) return payload as Project[];
  if (payload && typeof payload === 'object') {
    const projects = (payload as { projects?: unknown }).projects;
    if (Array.isArray(projects)) return projects as Project[];
  }
  return [];
}

/**
 * Shared POST for /presets/:id/enable and /presets/:id/disable (section 10.5).
 * `projectPath` is optional and only scopes access to custom presets.
 */
async function setPresetEnabled(
  id: string,
  enabled: boolean,
  options: { projectPath?: string } = {},
): Promise<PresetEnabledResult> {
  const action = enabled ? 'enable' : 'disable';
  const response = await authenticatedFetch(
    `${PRESETS_URL}/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', body: JSON.stringify({ projectPath: options.projectPath }) },
  );
  const data = await parseResponse<{ preset: Preset; tasks?: ScheduledTask[] }>(response);
  return { preset: data.preset, tasks: data.tasks ?? [] };
}

export const scheduledTasksApi = {
  async list(params: { status: TaskStatusFilter; search: string }): Promise<ScheduledTask[]> {
    const query = buildQuery({ status: toApiStatus(params.status), search: params.search.trim() });
    const response = await authenticatedFetch(`${BASE_URL}${query}`);
    const data = await parseResponse<{ tasks?: ScheduledTask[] }>(response);
    return data?.tasks ?? [];
  },

  /**
   * GET /running (section 14.3): how many scheduled tasks currently have a run
   * whose agent was actually started. The count is global (one scheduler), not
   * scoped to a user. A malformed payload reads as 0.
   */
  async runningCount(): Promise<number> {
    const response = await authenticatedFetch(`${BASE_URL}/running`);
    const data = await parseResponse<{ count?: unknown }>(response);
    const count = data?.count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  },

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const response = await authenticatedFetch(BASE_URL, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseResponse<{ task: ScheduledTask }>(response);
    return data.task;
  },

  async update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask> {
    const response = await authenticatedFetch(`${BASE_URL}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await parseResponse<{ task: ScheduledTask }>(response);
    return data.task;
  },

  async remove(id: string): Promise<void> {
    const response = await authenticatedFetch(`${BASE_URL}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parseResponse<{ id: string; deleted: boolean }>(response);
  },

  /**
   * POST /:id/run. `params` carries the per-run overrides of section 12.3;
   * omitting it keeps the pre-section-12 request body byte-identical.
   */
  async runNow(
    id: string,
    options: { params?: Record<string, unknown> } = {},
  ): Promise<ScheduledTaskRun> {
    const body = options.params === undefined ? undefined : JSON.stringify({ params: options.params });
    const response = await authenticatedFetch(`${BASE_URL}/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      ...(body === undefined ? {} : { body }),
    });
    const data = await parseResponse<{ run: ScheduledTaskRun }>(response);
    return data.run;
  },

  async listRuns(
    id: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ runs: ScheduledTaskRun[]; total: number }> {
    const query = buildQuery({ limit: options.limit ?? 20, offset: options.offset ?? 0 });
    const response = await authenticatedFetch(`${BASE_URL}/${encodeURIComponent(id)}/runs${query}`);
    const data = await parseResponse<{ runs?: ScheduledTaskRun[]; total?: number }>(response);
    const runs = data?.runs ?? [];
    return { runs, total: typeof data?.total === 'number' ? data.total : runs.length };
  },

  // --- Presets (section 10.5) ---------------------------------------------
  // These routes live under /api/scheduled-tasks/presets and are registered
  // before /:id on the server, so a preset id can never shadow a task id here.

  async listPresets(options: { projectPath?: string } = {}): Promise<Preset[]> {
    const query = buildQuery({ projectPath: options.projectPath });
    const response = await authenticatedFetch(`${PRESETS_URL}${query}`);
    const data = await parseResponse<{ presets?: Preset[] }>(response);
    return data?.presets ?? [];
  },

  async getPreset(id: string, options: { projectPath?: string } = {}): Promise<Preset> {
    const query = buildQuery({ projectPath: options.projectPath });
    const response = await authenticatedFetch(
      `${PRESETS_URL}/${encodeURIComponent(id)}${query}`,
    );
    const data = await parseResponse<{ preset: Preset }>(response);
    return data.preset;
  },

  async createPreset(input: CustomPresetInput): Promise<Preset> {
    const response = await authenticatedFetch(PRESETS_URL, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseResponse<{ preset: Preset }>(response);
    return data.preset;
  },

  async updatePreset(id: string, patch: PresetPatch): Promise<Preset> {
    const response = await authenticatedFetch(`${PRESETS_URL}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await parseResponse<{ preset: Preset }>(response);
    return data.preset;
  },

  /**
   * POST /presets/:id/install. `params` overrides template defaults for every
   * installed task that declares that name (section 12.5).
   */
  async installPreset(
    id: string,
    options: { projectPath: string; enabled?: boolean; params?: Record<string, unknown> },
  ): Promise<InstallPresetResult> {
    const response = await authenticatedFetch(
      `${PRESETS_URL}/${encodeURIComponent(id)}/install`,
      {
        method: 'POST',
        body: JSON.stringify({
          projectPath: options.projectPath,
          enabled: options.enabled,
          params: options.params,
        }),
      },
    );
    const data = await parseResponse<Partial<InstallPresetResult>>(response);
    return {
      preset: data.preset as Preset,
      tasks: data.tasks ?? [],
      created: data.created ?? [],
      updated: data.updated ?? [],
      skipped: data.skipped ?? [],
    };
  },

  async enablePreset(id: string, options: { projectPath?: string } = {}): Promise<PresetEnabledResult> {
    return setPresetEnabled(id, true, options);
  },

  async disablePreset(id: string, options: { projectPath?: string } = {}): Promise<PresetEnabledResult> {
    return setPresetEnabled(id, false, options);
  },

  async removePreset(
    id: string,
    options: { purge?: boolean; projectPath?: string } = {},
  ): Promise<DeletePresetResult> {
    const query = buildQuery({
      purge: options.purge === undefined ? undefined : options.purge ? 1 : 0,
      projectPath: options.projectPath,
    });
    const response = await authenticatedFetch(
      `${PRESETS_URL}/${encodeURIComponent(id)}${query}`,
      { method: 'DELETE' },
    );
    const data = await parseResponse<Partial<DeletePresetResult>>(response);
    return { id, deleted: data.deleted ?? true, removedTasks: data.removedTasks ?? 0 };
  },

  /**
   * Full projects payload, including each project's session collections.
   * Run history fetches this once per mount to resolve a run's session id into
   * a readable project + title (see utils/sessionLookup.ts).
   */
  async listProjects(): Promise<Project[]> {
    const response = await authenticatedFetch('/api/projects');
    const payload = await parseResponse<unknown>(response);
    return extractProjects(payload);
  },

  async listProjectOptions(): Promise<ProjectOption[]> {
    const response = await authenticatedFetch('/api/projects');
    const payload = await parseResponse<unknown>(response);
    return extractProjects(payload)
      .map((project) => {
        const value = project.fullPath || project.path || project.name;
        const label = project.displayName || project.name || value;
        return { value, label };
      })
      .filter((option) => Boolean(option.value));
  },
};
