import type { MessageRow } from '../db.js';
import type { JobInputRequestPayload } from '../user-input/db.js';

// ── API response shapes ──

export interface TopicResponse {
  id: number;
  name: string;
  language: string | null;
  parent_topic_id: number | null;
  sort_order: number;
  archived: number;
  archived_at: string | null;
  has_local_artifacts?: boolean;
  queued_job_count?: number;
  running_job_count?: number;
}

export interface AgentResponse {
  name: string;
  provider: string;
}

export interface UserResponse {
  id: string;
  email: string;
  handle: string | null;
  role: string;
  status: string;
}

export interface ProjectResponse {
  name: string;
  path: string;
  language: string;
  gitBranch: string | null;
  mode: 'private' | 'shared';
  bindHost: string;
  demo?: {
    enabled: boolean;
    topic_name: string;
    hotkey: string;
    delay_ms: number;
  };
}

export interface StatusResponse {
  name: string;
  topics: number;
  agents: number;
  users: number;
  clients: number;
}

export interface SessionResponse {
  id: string;
  email: string;
  handle: string | null;
  role: string;
  isOwner?: boolean;
  capabilities?: string[];
  fileRoots?: Array<{
    id: string;
    kind: 'workspace' | 'host';
    path: string;
  }>;
}

export interface InviteLinkResponse {
  link: string;
  token: string;
}

export interface ArtifactResponse {
  id: number;
  topic_id: number;
  artifact_class: string;
  kind: string;
  title: string;
  status: string;
  canonical_source: string;
  current_version_id: number | null;
  promoted_repo_path: string | null;
  promoted_commit_sha: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  created_by_user_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionResponse {
  id: number;
  artifact_id: number;
  version: number;
  content_type: string;
  body: string;
  summary: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  created_by_user_email: string | null;
  created_at: string;
}

export type JobInputRequestResponse = JobInputRequestPayload;

export interface MessageArtifactResponse {
  artifact_id: number;
  artifact_version_id: number;
  relation: string;
  kind: string;
  title: string;
  version: number;
}

export type { PresenceEntry } from './events.js';

export { MessageRow };
