import { spawn } from 'child_process';
import type { TeepeeConfig } from './config.js';
import { resolvePrompt, resolveTimeout } from './config.js';
import { getRecentMessages } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';

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
  lines.push('');

  lines.push('[messages]');
  for (const msg of messages) {
    lines.push(`${msg.author_name}> ${msg.body}`);
  }
  lines.push('');

  lines.push('[current]');
  if (trigger) {
    lines.push(`${trigger.author_name}> ${trigger.body}`);
  }

  return lines.join('\n');
}

/**
 * Run an agent command, piping context to stdin and streaming stdout.
 */
export function runAgent(
  command: string,
  context: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void
): Promise<JobResult> {
  return new Promise((resolve) => {
    const parts = command.split(/\s+/);
    const proc = spawn(parts[0], parts.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      onChunk?.(chunk);
    });

    proc.stderr.on('data', () => {
      // Discard stderr
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        output: output.trim(),
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

    proc.stdin.write(context);
    proc.stdin.end();
  });
}
