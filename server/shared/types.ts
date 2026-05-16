import type { IncomingMessage } from 'node:http';

export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

export type AnyRecord = Record<string, any>;

export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  claude_dir_name: string | null;
  isStarred: number;
  isArchived: number;
};

export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};
