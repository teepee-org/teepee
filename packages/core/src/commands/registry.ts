import type { CommandDef, CommandContext, UserRole } from './types.js';
import {
  topicLanguageCommand,
  topicRenameCommand,
  topicArchiveCommand,
  topicAliasCommand,
  topicMoveRootCommand,
  topicMoveIntoCommand,
  topicMoveBeforeCommand,
  topicMoveAfterCommand,
} from './topic-commands.js';

const commands = new Map<string, CommandDef>();

function register(cmd: CommandDef) {
  commands.set(cmd.name, cmd);
}

// Register built-in commands
register(topicLanguageCommand);
register(topicRenameCommand);
register(topicArchiveCommand);
register(topicAliasCommand);
register(topicMoveRootCommand);
register(topicMoveIntoCommand);
register(topicMoveBeforeCommand);
register(topicMoveAfterCommand);

export function getCommand(name: string): CommandDef | undefined {
  return commands.get(name);
}

export function listCommands(): CommandDef[] {
  return [...commands.values()];
}

const ROLE_LEVEL: Record<UserRole, number> = { observer: 0, collaborator: 1, owner: 2 };

function hasMinRole(userRole: string, minRole: UserRole): boolean {
  return (ROLE_LEVEL[userRole as UserRole] ?? 0) >= ROLE_LEVEL[minRole];
}

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  systemMessage?: string;
}

/**
 * Execute a named command with role checking.
 */
export function executeCommand(
  commandName: string,
  ctx: CommandContext,
  params: Record<string, any>
): ExecuteResult {
  const cmd = commands.get(commandName);
  if (!cmd) {
    return { ok: false, error: `Unknown command: ${commandName}` };
  }

  if (!hasMinRole(ctx.user.role, cmd.minRole)) {
    return { ok: false, error: cmd.minRole === 'owner' ? 'Owner only' : 'Insufficient permissions' };
  }

  return cmd.execute(ctx, params);
}
