import type { Database as DatabaseType } from 'better-sqlite3';
import type { SessionUser } from '../auth.js';
import type { Capability, TeepeeConfig } from '../config.js';

export type UserRole = string;

export type AgentAccessProfile = 'readonly' | 'draft' | 'readwrite' | 'trusted';

export type ChainPolicy = 'none' | 'propose_only' | 'delegate_with_origin_policy';

export interface CommandContext {
  db: DatabaseType;
  config: TeepeeConfig;
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
  /** Capability required to execute the command. */
  requiredCapability: Capability;
  /** Validate and execute the command. Params is the raw payload minus `command` and `topicId`. */
  execute(ctx: CommandContext, params: Record<string, any>): CommandResult;
}
