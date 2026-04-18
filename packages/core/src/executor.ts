import { spawn } from 'child_process';
import type { TeepeeConfig, ExecutionMode } from './config.js';
import { resolvePrompt } from './config.js';
import { getRecentMessages } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { parseMentions } from './mentions.js';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';
import { prepareCommandParts, isCodexExecCommand, checkSandboxCommandAvailability, buildSandboxCommandMountPlan } from './command.js';
import { parserForCommand, isClaudeStreamJson, extractClaudeStreamJsonFinal, type StreamEvent } from './stream-parsers.js';

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
  const artifactFocusedMode = topicArtifacts !== undefined;
  const messages = getRecentMessages(db, topicId, artifactFocusedMode ? 12 : 20);
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
    lines.push('You may create or update Markdown document artifacts by writing JSON files under $TEEPEE_OUTPUT_DIR.');
    lines.push('The examples and field lists below are the complete and authoritative specification of this protocol. Do not inspect source code, databases, or other files in the project to verify these formats — follow the shapes shown here exactly.');
    lines.push('Valid artifact kinds: plan, spec, adr, report, review.');
    lines.push('Markdown body content always goes in a file under $TEEPEE_OUTPUT_DIR/files/, referenced by the "path" field. Bodies are full documents, never diffs.');
    lines.push('');
    lines.push('Example — READ the current version of artifact 42 (write $TEEPEE_OUTPUT_DIR/artifact-ops.json):');
    lines.push('{');
    lines.push('  "operations": [');
    lines.push('    { "op_id": "read-head", "op": "read-current", "artifact_id": 42 }');
    lines.push('  ]');
    lines.push('}');
    lines.push('Teepee will then re-invoke you with the body under [artifact-op-results].');
    lines.push('');
    lines.push('Example — EDIT artifact 42 with small targeted changes (write $TEEPEE_OUTPUT_DIR/artifacts.json, NO file needed):');
    lines.push('{');
    lines.push('  "documents": [');
    lines.push('    {');
    lines.push('      "op": "edit",');
    lines.push('      "artifact_id": 42,');
    lines.push('      "base_version": "current",');
    lines.push('      "edits": [');
    lines.push('        { "find": "## Riferimenti\\n", "replace": "## Riferimenti\\n- [Karpathy gist](https://gist.github.com/...)\\n" }');
    lines.push('      ]');
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    lines.push('Each edit requires "find" (unique substring of the current body) and "replace". Add "replace_all": true if "find" occurs multiple times intentionally. Edits apply sequentially; each edit operates on the result of the previous.');
    lines.push('');
    lines.push('Example — UPDATE artifact 42 by rewriting the full body (write $TEEPEE_OUTPUT_DIR/artifacts.json AND $TEEPEE_OUTPUT_DIR/files/42-next.md):');
    lines.push('{');
    lines.push('  "documents": [');
    lines.push('    { "op": "update", "artifact_id": 42, "base_version": "current", "path": "files/42-next.md" }');
    lines.push('  ]');
    lines.push('}');
    lines.push('');
    lines.push('Example — CREATE a new artifact (write $TEEPEE_OUTPUT_DIR/artifacts.json AND $TEEPEE_OUTPUT_DIR/files/my-doc.md):');
    lines.push('{');
    lines.push('  "documents": [');
    lines.push('    { "op": "create", "kind": "spec", "title": "My New Doc", "path": "files/my-doc.md" }');
    lines.push('  ]');
    lines.push('}');
    lines.push('');
    lines.push('Artifact-ops root key is "operations" (not "ops"). Artifacts root key is "documents".');
    lines.push('Read operations: read-current {artifact_id}; read-version {artifact_id, version}; read-diff {artifact_id, from_version, to_version, format?}. Version refs accept an integer or "current".');
    lines.push('Write operations: create {kind, title, path}; update {artifact_id, base_version, path}; edit {artifact_id, base_version, edits[{find, replace, replace_all?}]}; rewrite-from-version {artifact_id, base_version, source_version, path}; restore {artifact_id, base_version, restore_version}.');
    lines.push('Do not emit update, edit, rewrite-from-version, or restore operations unless you first read the current head version of that artifact in this run.');
    lines.push('For any existing document change, use this workflow: read-current on the target artifact, optionally read-version/read-diff for history, then write artifacts.json using base_version from read-current.');
    lines.push('Prefer base_version: "current" after read-current; it is safer than copying numeric versions by hand and still requires the read-current precondition.');
    lines.push("STRONGLY PREFER 'edit' for small targeted changes (adding/removing a line, link, section, paragraph) — it is dramatically cheaper and faster than rewriting the whole body. Use 'update' only when the change is substantial (rewriting large sections). Use 'rewrite-from-version' when the requested content must be materially derived from a historical version; that requires both read-current of the head and read-version of source_version in the same run. Use 'restore' only to recreate an older version as the new head.");
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
    lines.push(
      `${msg.author_name}> ${formatContextMessageBody(
        msg.body,
        artifactFocusedMode && msg.id !== triggerMessageId
      )}`
    );
  }
  lines.push('');

  lines.push('[current]');
  if (trigger) {
    lines.push(`${trigger.author_name}> ${personalizeTriggerBody(trigger.body)}`);
  }

  return lines.join('\n');
}

const ARTIFACT_CONTEXT_MESSAGE_LIMIT = 900;

function formatContextMessageBody(body: string, truncateForArtifactFocus: boolean): string {
  if (!truncateForArtifactFocus || body.length <= ARTIFACT_CONTEXT_MESSAGE_LIMIT) {
    return body;
  }

  const kept = body.slice(0, ARTIFACT_CONTEXT_MESSAGE_LIMIT).trimEnd();
  const omitted = body.length - kept.length;
  return `${kept}\n[… truncated ${omitted} chars of earlier topic history …]`;
}

export interface RunAgentOptions {
  command: string;
  context: string;
  /**
   * Idle timeout in milliseconds. If no stdout/stderr chunk is received for
   * this many ms, the runner sends SIGTERM, waits killGraceMs, and then
   * SIGKILL. A falsy value disables idle-timeout enforcement for this run.
   */
  timeoutMs?: number;
  /**
   * Grace window in ms between SIGTERM and SIGKILL when the idle timeout fires.
   * Defaults to 5000.
   */
  killGraceMs?: number;
  cwd: string;
  executionMode?: ExecutionMode;
  sandboxRunner?: SandboxRunner;
  sandboxOptions?: SandboxOptions;
  onChunk?: (chunk: string) => void;
  /** Called for each StreamEvent extracted from provider output. */
  onActivity?: (event: StreamEvent) => void;
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
    const isClaudeStreamJsonCmd = isClaudeStreamJson(opts.command);

    const RUNNABLE_MODES = new Set(['host', 'sandbox']);
    if (opts.executionMode && !RUNNABLE_MODES.has(opts.executionMode)) {
      resolve({ output: `Blocked: unknown execution mode '${opts.executionMode}'`, exitCode: 1, timedOut: false });
      return;
    }

    let proc;
    const useSandbox = opts.executionMode === 'sandbox';
    if (useSandbox && opts.sandboxRunner && opts.sandboxOptions) {
      if (opts.sandboxRunner.name === 'bubblewrap') {
        const sandboxCheck = checkSandboxCommandAvailability(opts.command);
        const mountPlan = buildSandboxCommandMountPlan(opts.command);
        if (!sandboxCheck.ok && !mountPlan) {
          resolve({
            output: '',
            exitCode: 1,
            timedOut: false,
            error: `${sandboxCheck.error}. Install it in /usr/local/bin or /usr/bin, or use profile 'trusted' if host execution is intended.`,
          });
          return;
        }
      }
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
      clearIdleTimer();
      clearKillTimer();
      resolve(result);
    };

    // ── Idle timer (SIGTERM → grace → SIGKILL on no-output window) ──
    const idleBudgetMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
    const killGraceMs = opts.killGraceMs && opts.killGraceMs > 0 ? opts.killGraceMs : 5000;

    let idleTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const onIdle = () => {
      idleTimer = null;
      if (settled) return;
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        if (settled) return;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, killGraceMs);
    };

    const armIdleTimer = () => {
      if (idleBudgetMs <= 0) return;
      clearIdleTimer();
      idleTimer = setTimeout(onIdle, idleBudgetMs);
    };

    // ── Stream parsing (activity events + structured text routing) ──
    // Always build the parser when the provider emits structured (JSON-line)
    // output: we use it both to extract activity events for the UI indicator
    // and to lift the assistant text out of the raw JSON so the chat bubble
    // renders prose instead of the event log.
    const providerIsStructured = isCodexExecJson || isClaudeStreamJsonCmd;
    const wantsParser = Boolean(opts.onActivity) || providerIsStructured;
    const parser = wantsParser ? parserForCommand(opts.command) : null;

    const handleChunk = (chunk: string, stream: 'stdout' | 'stderr') => {
      armIdleTimer(); // any chunk resets the idle timer
      if (!parser) return;
      for (const event of parser.feed(chunk, stream)) {
        if (providerIsStructured && event.kind === 'text_delta' && event.text) {
          // Forward the parsed text (not the raw JSON chunk) to the UI.
          try {
            opts.onChunk?.(event.text);
          } catch {
            /* UI consumer errors must not break the run */
          }
        }
        if (opts.onActivity) {
          try {
            opts.onActivity(event);
          } catch {
            /* as above */
          }
        }
      }
    };

    armIdleTimer();

    proc.stdout!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      // Only forward the raw chunk to the UI stream for providers that emit
      // plain text on stdout. Codex JSON and Claude stream-json are handled
      // via their parsers (see handleChunk above / extractCodexFinalMessage
      // / extractClaudeStreamJsonFinal).
      if (!isCodexExecJson && !isClaudeStreamJsonCmd) {
        opts.onChunk?.(chunk);
      }
      handleChunk(chunk, 'stdout');
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      handleChunk(chunk, 'stderr');
    });

    proc.stdin!.on('error', () => {
      // Some provider wrappers exit before reading stdin; ignore broken pipe errors.
    });

    proc.on('close', (code, signal) => {
      let normalizedOutput: string;
      if (isCodexExecJson) {
        normalizedOutput = extractCodexFinalMessage(output);
      } else if (isClaudeStreamJsonCmd) {
        normalizedOutput = extractClaudeStreamJsonFinal(output) ?? output.trim();
      } else {
        normalizedOutput = output.trim();
      }
      if (timedOut) {
        const seconds = Math.round(idleBudgetMs / 1000);
        resolveOnce({
          output: normalizedOutput,
          exitCode: code ?? 1,
          timedOut: true,
          stderr: stderr.trim(),
          signal,
          error: `Idle timeout: no output for ${seconds}s`,
        });
        return;
      }
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
