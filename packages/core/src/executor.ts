import { spawn } from 'child_process';
import type { TeepeeConfig, ExecutionMode } from './config.js';
import { resolvePrompt } from './config.js';
import { getRecentMessages } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { parseMentions } from './mentions.js';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';
import { prepareCommandParts, isCodexExecCommand } from './command.js';

export interface JobResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  stderr?: string;
  error?: string;
  signal?: NodeJS.Signals | null;
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
export interface ArtifactContextEntry {
  id: number;
  kind: string;
  title: string;
  current_version: number;
}

export function buildContext(
  db: DatabaseType,
  agentName: string,
  topicId: number,
  triggerMessageId: number,
  language: string,
  config: TeepeeConfig,
  basePath: string,
  topicArtifacts?: ArtifactContextEntry[],
  artifactOpResults?: string,
  artifactWriteError?: string,
  userInputResults?: string
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

  if (topicArtifacts && topicArtifacts.length >= 0) {
    lines.push('[artifacts/v2]');
    lines.push('You may create or update Markdown document artifacts by writing artifacts.json and files under $TEEPEE_OUTPUT_DIR.');
    lines.push('Artifact content access is lazy: request document reads by writing artifact-ops.json with read-current, read-version, or read-diff operations.');
    lines.push('Do not emit update, rewrite-from-version, or restore operations unless you first read the current head version of that artifact in this run.');
    lines.push('For any existing document edit, use this workflow: read-current on the target artifact, optionally read-version/read-diff for history, then write artifacts.json using base_version from read-current.');
    lines.push('Prefer base_version: "current" after read-current; it is safer than copying numeric versions by hand and still requires the read-current precondition.');
    lines.push("Use 'update' when history is only reference material. Use 'rewrite-from-version' when the requested content must be materially derived from a historical version; that requires both read-current of the head and read-version of source_version in the same run. Use 'restore' only to recreate an older version as the new head.");
    if (topicArtifacts.length > 0) {
      lines.push('Existing documents:');
      for (const a of topicArtifacts) {
        lines.push(`- artifact_id=${a.id} kind=${a.kind} title="${a.title}" current_version=${a.current_version}`);
      }
    }
    lines.push('If the target is ambiguous, ask for clarification instead of guessing.');
    lines.push('');
  }

  if (topicArtifacts !== undefined) {
    lines.push('[user-input]');
    lines.push('You may request structured human input by writing user-input.json under $TEEPEE_OUTPUT_DIR.');
    lines.push('Do not wait for stdin. Teepee will pause the job and reinvoke you with [user-input-results].');
    lines.push('Use this only when you are blocked on a human decision that materially changes the next action.');
    lines.push('At most one pending input request is allowed per job.');
    lines.push('In v1, only the user who started the job can answer.');
    lines.push('');
  }

  if (artifactOpResults) {
    lines.push('[artifact-op-results]');
    lines.push(artifactOpResults);
    lines.push('');
  }

  if (artifactWriteError) {
    lines.push('[artifact-write-error]');
    lines.push(artifactWriteError);
    lines.push('');
  }

  if (userInputResults) {
    lines.push('[user-input-results]');
    lines.push(userInputResults);
    lines.push('');
  }

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
  timeoutMs?: number;
  cwd: string;
  executionMode?: ExecutionMode;
  sandboxRunner?: SandboxRunner;
  sandboxOptions?: SandboxOptions;
  onChunk?: (chunk: string) => void;
  outputDir?: string;
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

    const RUNNABLE_MODES = new Set(['host', 'sandbox']);
    if (opts.executionMode && !RUNNABLE_MODES.has(opts.executionMode)) {
      resolve({ output: `Blocked: unknown execution mode '${opts.executionMode}'`, exitCode: 1, timedOut: false });
      return;
    }

    let proc;
    const useSandbox = opts.executionMode === 'sandbox';
    if (useSandbox && opts.sandboxRunner && opts.sandboxOptions) {
      proc = opts.sandboxRunner.spawn(parts[0], parts.slice(1), opts.sandboxOptions);
    } else {
      const hostEnv = { ...process.env };
      if (opts.outputDir) {
        hostEnv.TEEPEE_OUTPUT_DIR = opts.outputDir;
      }
      proc = spawn(parts[0], parts.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: opts.cwd,
      });
    }

    let output = '';
    let stderr = '';
    let settled = false;

    const resolveOnce = (result: JobResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      if (!isCodexExecJson) {
        opts.onChunk?.(chunk);
      }
    });

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin!.on('error', () => {
      // Some provider wrappers exit before reading stdin; ignore broken pipe errors.
    });

    proc.on('close', (code, signal) => {
      const normalizedOutput = isCodexExecJson ? extractCodexFinalMessage(output) : output.trim();
      resolveOnce({
        output: normalizedOutput,
        exitCode: code ?? 1,
        timedOut: false,
        stderr: stderr.trim(),
        signal,
      });
    });

    proc.on('error', (err) => {
      resolveOnce({
        output: '',
        exitCode: 1,
        timedOut: false,
        stderr: stderr.trim(),
        error: err.message,
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
