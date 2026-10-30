import { authenticatedFetch } from '../../utils/api';
import type { Project } from '../../types/app';
import type {
  ProjectOption,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  ScheduledTaskRun,
  TaskStatusFilter,
} from './types';

const BASE_URL = '/api/scheduled-tasks';

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

export const scheduledTasksApi = {
  async list(params: { status: TaskStatusFilter; search: string }): Promise<ScheduledTask[]> {
    const query = buildQuery({ status: toApiStatus(params.status), search: params.search.trim() });
    const response = await authenticatedFetch(`${BASE_URL}${query}`);
    const data = await parseResponse<{ tasks?: ScheduledTask[] }>(response);
    return data?.tasks ?? [];
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

  async runNow(id: string): Promise<ScheduledTaskRun> {
    const response = await authenticatedFetch(`${BASE_URL}/${encodeURIComponent(id)}/run`, {
      method: 'POST',
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
