import type { Database as DatabaseType } from 'better-sqlite3';
import type { SessionUser } from '../auth.js';

export type UserRole = 'owner' | 'collaborator' | 'observer';

export type AgentAccessProfile = 'readonly' | 'readwrite' | 'trusted';

export type ChainPolicy = 'none' | 'propose_only' | 'delegate_with_origin_policy';

export interface CommandContext {
  db: DatabaseType;
  user: SessionUser;
  topicId: number;
  broadcast: (topicId: number, event: object) => void;
  /** Broadcast to all connected clients regardless of topic subscription. */
  broadcastGlobal?: (event: object) => void;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
  systemMessage?: string;
}

export interface CommandDef {
  name: string;
  help: string;
  /** Minimum role required. 'collaborator' means collaborator or owner. 'owner' means owner only. */
  minRole: UserRole;
  /** Validate and execute the command. Params is the raw payload minus `command` and `topicId`. */
  execute(ctx: CommandContext, params: Record<string, any>): CommandResult;
}
