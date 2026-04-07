import type { Database as DatabaseType } from 'better-sqlite3';
import type { SessionUser } from '../auth.js';

export type UserRole = 'owner' | 'user' | 'observer';

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
  /** Minimum role required. 'user' means user or owner. 'owner' means owner only. */
  minRole: UserRole;
  /** Validate and execute the command. Params is the raw payload minus `command` and `topicId`. */
  execute(ctx: CommandContext, params: Record<string, any>): CommandResult;
}
