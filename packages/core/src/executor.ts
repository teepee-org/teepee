import { spawn } from 'child_process';
import type { TeepeeConfig, ExecutionMode } from './config.js';
import { resolvePrompt, resolveTimeout } from './config.js';
import { getRecentMessages } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { parseMentions } from './mentions.js';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';
import { prepareCommandParts, isCodexExecCommand } from './command.js';

export interface JobResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Build the stdin context for an agent invocation.
 *
 * Format:
 *   [teepee/v1]
 *   [system]
 *   <prompt>
 *   <language instruction>
 *   [messages]
 *   <recent messages>
 *   [current]
 *   <trigger message>
 */
export function buildContext(
  db: DatabaseType,
  agentName: string,
  topicId: number,
  triggerMessageId: number,
  language: string,
  config: TeepeeConfig,
  basePath: string
): string {
  const prompt = resolvePrompt(agentName, config.agents[agentName], basePath);
  const messages = getRecentMessages(db, topicId, 20);
  const trigger = messages.find((m) => m.id === triggerMessageId);

  const lines: string[] = ['[teepee/v1]', '', '[system]'];
  lines.push(prompt);
  lines.push('');
  lines.push(`You must answer in ${language}.`);
  lines.push(
    'Do not translate code, commands, file paths or identifiers.'
  );
  lines.push(`You are @${agentName}. Respond only as @${agentName}.`);
  lines.push('Do not speak on behalf of other agents, the system, or the whole team.');
  lines.push('If multiple agents are mentioned, assume each agent replies separately with its own perspective.');
  lines.push('Never tag yourself with @your-name. When referring to yourself, use your plain name without @.');
  lines.push('Do not delegate, hand off, or tag another agent unless the user explicitly asked you to do that in the current request.');
  lines.push('If you want to suggest a follow-up from another agent without triggering them, refer to them as "@agent".');
  lines.push('Never claim that you created files, changed code, ran commands, or completed deliverables unless you actually did so in this run.');
  lines.push('Report successful edits and blocked steps separately. If you changed files but could not verify them, say the edits were applied but remain unverified.');
  lines.push('If you are blocked by permissions, missing tools, or failed commands, say exactly which step was blocked. Do not claim blocked steps succeeded or were verified.');
  lines.push('Tag another agent with @agent only when you want that agent to take action or produce a follow-up response.');
  lines.push('When referring to another agent without triggering them, quote the mention like "@agent".');
  lines.push('');

  lines.push('[messages]');
  for (const msg of messages) {
    lines.push(`${msg.author_name}> ${msg.body}`);
  }
  lines.push('');

  lines.push('[current]');
  if (trigger) {
    lines.push(`${trigger.author_name}> ${personalizeTriggerBody(trigger.body)}`);
  }

  return lines.join('\n');
}

export interface RunAgentOptions {
  command: string;
  context: string;
  timeoutMs: number;
  cwd: string;
  executionMode?: ExecutionMode;
  sandboxRunner?: SandboxRunner;
  sandboxOptions?: SandboxOptions;
  onChunk?: (chunk: string) => void;
}

/**
 * Run an agent command, piping context to stdin and streaming stdout.
 * Supports both host and sandboxed execution modes.
 */
export function runAgent(
  commandOrOpts: string | RunAgentOptions,
  context?: string,
  timeoutMs?: number,
  cwd?: string,
  onChunk?: (chunk: string) => void
): Promise<JobResult> {
  // Support both old positional API and new options API
  const opts: RunAgentOptions =
    typeof commandOrOpts === 'string'
      ? { command: commandOrOpts, context: context!, timeoutMs: timeoutMs!, cwd: cwd!, onChunk }
      : commandOrOpts;

  return new Promise((resolve) => {
    const parts = prepareCommandParts(opts.command);
    const isCodexExecJson = isCodexExecCommand(parts);

    // Runtime guard: only 'host' and 'sandbox' are runnable modes.
    // Any unknown or 'disabled' mode must not reach here, but if it does, fail closed.
    if (opts.executionMode && opts.executionMode !== 'host' && opts.executionMode !== 'sandbox') {
      resolve({ output: `Blocked: unknown execution mode '${opts.executionMode}'`, exitCode: 1, timedOut: false });
      return;
    }

    let proc;
    if (opts.executionMode === 'sandbox' && opts.sandboxRunner && opts.sandboxOptions) {
      proc = opts.sandboxRunner.spawn(parts[0], parts.slice(1), opts.sandboxOptions);
    } else {
      proc = spawn(parts[0], parts.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: opts.cwd,
      });
    }

    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, opts.timeoutMs);

    proc.stdout!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      if (!isCodexExecJson) {
        opts.onChunk?.(chunk);
      }
    });

    proc.stderr!.on('data', () => {
      // Discard stderr
    });

    proc.stdin!.on('error', () => {
      // Some provider wrappers exit before reading stdin; ignore broken pipe errors.
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const normalizedOutput = isCodexExecJson ? extractCodexFinalMessage(output) : output.trim();
      resolve({
        output: normalizedOutput,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        output: '',
        exitCode: 1,
        timedOut: false,
      });
    });

    try {
      proc.stdin!.write(opts.context);
      proc.stdin!.end();
    } catch {
      // The process may have already exited.
    }
  });
}

function extractCodexFinalMessage(output: string): string {
  const lines = output.split('\n');
  let lastAgentMessage: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === 'item.completed' && parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
        lastAgentMessage = parsed.item.text.trim();
      }
    } catch {
      // Ignore non-JSON or partial JSON lines from provider stdout.
    }
  }

  return lastAgentMessage ?? output.trim();
}

function personalizeTriggerBody(body: string): string {
  const { active } = parseMentions(body);
  if (active.length === 0) return body;

  return body
    .split(/\r?\n/)
    .map((line) => stripActiveMentionsFromLine(line, active))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s+\)/g, '()')
    .trim();
}

function stripActiveMentionsFromLine(line: string, activeAgents: string[]): string {
  let result = '';
  const chars = [...line];
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inInlineCode = false;

  while (i < chars.length) {
    if (chars[i] === '`') {
      inInlineCode = !inInlineCode;
      result += chars[i];
      i++;
      continue;
    }

    if (!inInlineCode && chars[i] === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += chars[i];
      i++;
      continue;
    }

    if (!inInlineCode && chars[i] === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += chars[i];
      i++;
      continue;
    }

    if (!inInlineCode && !inSingleQuote && !inDoubleQuote && chars[i] === '@') {
      let end = i + 1;
      while (end < chars.length && /[a-zA-Z0-9_\-]/.test(chars[end])) {
        end++;
      }
      const name = chars.slice(i + 1, end).join('');
      if (name && activeAgents.includes(name)) {
        i = end;
        while (chars[i] === ' ') i++;
        continue;
      }
    }

    result += chars[i];
    i++;
  }

  return result;
}
