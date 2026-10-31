export type SessionProvider = 'claude' | 'cursor' | 'codex' | 'gemini' | 'copilot';

export type AppTab = 'chat' | 'shell' | 'tasks' | 'preview' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  hiddenFromRecents?: boolean;
  isRead?: boolean;
  forkParentId?: string;
  projectPath?: string;
  __provider?: SessionProvider;
  __projectName?: string;
  __searchTargetTimestamp?: string | null;
  __searchTargetSnippet?: string | null;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ProjectAvailabilityStatus = 'available' | 'missing';

export type ProjectAvailabilityReason =
  | 'not_found'
  | 'not_a_directory'
  | 'empty_path'
  | 'permission_denied'
  | 'check_failed'
  | 'check_timeout';

/**
 * Server-computed availability of a project's directory (issue #16).
 * `status === 'missing'` is the only state that blocks opening the project; permission /
 * transient stat failures keep the project available and only set `reason`/`readable`.
 */
export interface ProjectAvailability {
  status: ProjectAvailabilityStatus;
  available: boolean;
  readable: boolean | null;
  reason: ProjectAvailabilityReason | null;
  errorCode: string | null;
}

export interface Project {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
  availability?: ProjectAvailability;
  sessions?: ProjectSession[];
  cursorSessions?: ProjectSession[];
  codexSessions?: ProjectSession[];
  geminiSessions?: ProjectSession[];
  copilotSessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  currentBranch?: string | null;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  changedFile?: string;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string;[key: string]: unknown };
