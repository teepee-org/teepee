import type { MessageRow } from '../db.js';

// ── API response shapes ──

export interface TopicResponse {
  id: number;
  name: string;
  language: string | null;
  archived: number;
  divider_id: number | null;
  subject_id: number | null;
  position: number;
  archived_divider_id: number | null;
  archived_subject_id: number | null;
  archived_at: string | null;
}

export interface DividerResponse {
  id: number;
  name: string;
  position: number;
}

export interface SubjectResponse {
  id: number;
  name: string;
  divider_id: number | null;
  parent_id: number | null;
  position: number;
}

export interface AgentResponse {
  name: string;
  provider: string;
}

export interface UserResponse {
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
  email: string;
  handle: string | null;
  role: string;
}

export interface InviteLinkResponse {
  link: string;
  token: string;
}

export { MessageRow };
