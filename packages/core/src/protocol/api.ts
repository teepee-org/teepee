import type { MessageRow } from '../db.js';

// ── API response shapes ──

export interface TopicResponse {
  id: number;
  name: string;
  language: string | null;
  archived: number;
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
