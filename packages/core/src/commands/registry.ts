import type { CommandDef, CommandContext } from './types.js';
import { hasCapability } from '../config.js';
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

  if (!hasCapability(ctx.config, ctx.user.role, cmd.requiredCapability)) {
    return { ok: false, error: 'Insufficient permissions' };
  }

  return cmd.execute(ctx, params);
}
