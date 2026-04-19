/**
 * Provider stream parsers.
 *
 * Converts raw stdout/stderr chunks from provider CLIs into normalized
 * StreamEvent objects that the runner can forward to the orchestrator, and
 * the UI can surface as live agent activity.
 *
 * Two parsers are shipped:
 *
 *   - Claude `-p --output-format stream-json --verbose` emits newline-
 *     delimited JSON. We parse each event (content_block_start with tool_use,
 *     content_block_delta with text, etc.) and emit a StreamEvent per
 *     meaningful item.
 *
 *   - Codex `exec` emits plain text on stdout and tool invocations on
 *     stderr. We heuristically pick out shell commands (`$ cmd …`) and emit
 *     text_delta for stdout bursts.
 *
 * Unknown providers fall back to emitting text_delta with a short preview of
 * each chunk — enough for the UI to show "something is happening".
 */

export type StreamEvent =
  | { kind: 'tool_use'; tool: string; target?: string }
  | { kind: 'shell'; command: string }
  /**
   * Assistant text delta.
   *
   * - `preview` is a short, whitespace-collapsed, length-capped string for
   *   the UI activity indicator.
   * - `text` (when present) is the full, un-truncated delta as emitted by
   *   the provider. The runner forwards this to the message-stream pipeline
   *   instead of the raw provider output when the provider emits structured
   *   JSON rather than plain text (e.g. Claude `--output-format stream-json`).
   */
  | { kind: 'text_delta'; preview: string; text?: string };

export interface StreamParser {
  /** Feed a raw chunk from the given stream; returns the events extracted. */
  feed(chunk: string, stream: 'stdout' | 'stderr'): StreamEvent[];
}

/** Default maximum length of a text preview rendered in the UI. */
export const DEFAULT_PREVIEW_LENGTH = 60;

/** Build the right parser for a provider command. */
export function parserForCommand(command: string, previewLength: number = DEFAULT_PREVIEW_LENGTH): StreamParser {
  if (isClaudeStreamJson(command)) {
    return new ClaudeStreamJsonParser(previewLength);
  }
  if (isCodexExec(command)) {
    return new CodexParser(previewLength);
  }
  return new GenericTextParser(previewLength);
}

export function isClaudeStreamJson(command: string): boolean {
  return /\bclaude\b/.test(command) && /--output-format\s+stream-json/.test(command);
}

export function isCodexExec(command: string): boolean {
  return /\bcodex\b/.test(command) && /\bexec\b/.test(command);
}

/**
 * Inspect each provider command and return human-readable warnings for
 * provider commands that do not request a streaming output format. Idle-
 * timeout enforcement and the live activity indicator rely on a streaming
 * provider; a provider that buffers silently cannot be protected.
 */
export function collectNonStreamingProviderWarnings(
  providers: Record<string, { command: string }>
): string[] {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    const cmd = provider.command;
    if (/\bclaude\b/.test(cmd) && !isClaudeStreamJson(cmd)) {
      warnings.push(
        `Provider '${name}': 'claude' command does not include '--output-format stream-json'. ` +
          `Idle-timeout enforcement and stream activity indicator will not apply to this provider. ` +
          `Add '--output-format stream-json --verbose' to the command to enable them.`
      );
    }
  }
  return warnings;
}

function summarizePreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trimEnd() + '…';
}

/**
 * Claude `--output-format stream-json --verbose` parser.
 *
 * The Claude Code CLI emits newline-delimited JSON with events shaped like:
 *
 *   { type: "system", subtype: "init", … }                 — ignored
 *   { type: "rate_limit_event", … }                         — ignored
 *   { type: "assistant", message: { content: [ { type: "thinking" | "tool_use" | "text", … } ] } }
 *   { type: "user", message: { content: [ { type: "tool_result", … } ] } }
 *   { type: "result", subtype: "success", result: "<final text>", … }
 *
 * For each assistant event we walk `message.content` and emit:
 *   - tool_use blocks → StreamEvent.tool_use
 *   - text blocks → StreamEvent.text_delta with the full text in `text` and a
 *     short `preview` for the UI activity indicator.
 *
 * Chunks may split mid-line; we buffer by newline and parse each complete
 * line as JSON.
 */
export class ClaudeStreamJsonParser implements StreamParser {
  private buffer = '';
  constructor(private previewLength: number) {}

  feed(chunk: string, stream: 'stdout' | 'stderr'): StreamEvent[] {
    // Claude stream-json events are emitted on stdout only. Mixing stderr
    // into the same line buffer can corrupt a pending JSON line (e.g. a
    // warning appearing mid-chunk) and lose downstream events. Ignore stderr
    // entirely — a separate parser could handle it if we ever need to surface
    // provider diagnostics.
    if (stream !== 'stdout') return [];
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        for (const evt of this.tryParseLine(line)) {
          events.push(evt);
        }
      }
      newlineIdx = this.buffer.indexOf('\n');
    }
    return events;
  }

  private tryParseLine(line: string): StreamEvent[] {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }

    // Raw Anthropic API streaming (kept for robustness if a future CLI mode
    // uses the API-style events).
    if (obj?.type === 'content_block_start' && obj?.content_block?.type === 'tool_use') {
      const tool = String(obj.content_block.name ?? 'unknown');
      const target = extractToolTarget(tool, obj.content_block.input ?? {});
      return [{ kind: 'tool_use', tool, target }];
    }
    if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta' && typeof obj.delta.text === 'string') {
      const ev = this.buildTextEvent(obj.delta.text);
      return ev ? [ev] : [];
    }

    // Claude Code CLI event wrappers — the common case.
    const contentArrays: any[][] = [];
    if ((obj?.type === 'assistant' || obj?.type === 'message') && Array.isArray(obj?.message?.content)) {
      contentArrays.push(obj.message.content);
    }

    const events: StreamEvent[] = [];
    for (const content of contentArrays) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          const tool = String(block.name ?? 'unknown');
          const target = extractToolTarget(tool, block.input ?? {});
          events.push({ kind: 'tool_use', tool, target });
          continue;
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
          const ev = this.buildTextEvent(block.text);
          if (ev) events.push(ev);
          continue;
        }
        // thinking / tool_result etc. are intentionally not surfaced as events
        // (they would be noise in the UI).
      }
    }
    return events;
  }

  private buildTextEvent(text: string): StreamEvent | null {
    const preview = summarizePreview(text, this.previewLength);
    if (preview.length === 0) return null;
    return { kind: 'text_delta', preview, text };
  }
}

/**
 * Extract the final agent text from a Claude stream-json stdout buffer.
 *
 * Looks for the last `{ "type": "result", … }` line; if present returns its
 * `result` string. Falls back to concatenating all `assistant.text` blocks.
 * If nothing sensible can be extracted, returns `null` and the caller should
 * fall back to the raw buffer.
 */
export function extractClaudeStreamJsonFinal(buffer: string): string | null {
  const lines = buffer.split('\n');
  let resultText: string | null = null;
  const textPieces: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === 'result' && typeof obj.result === 'string') {
      resultText = obj.result;
      continue;
    }
    if (obj?.type === 'assistant' && Array.isArray(obj?.message?.content)) {
      for (const block of obj.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textPieces.push(block.text);
        }
      }
    }
  }
  if (resultText !== null) return resultText.trim();
  if (textPieces.length > 0) return textPieces.join('').trim();
  return null;
}

function extractToolTarget(tool: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.filePath === 'string') return input.filePath;
  if (tool === 'Bash' && typeof input.command === 'string') return summarizePreview(input.command, 80);
  return undefined;
}

/**
 * Codex `exec` parser.
 *
 * Teepee runs `codex exec` with `--json` added automatically (see
 * prepareCommandParts in command.ts). Codex then emits newline-delimited
 * JSON on stdout with shapes like:
 *
 *   { "type": "thread.started", "thread_id": "…" }
 *   { "type": "item.added", "item": { "type": "command_execution", "command": "rg --files .", … } }
 *   { "type": "item.completed", "item": { "type": "command_execution", "exit_code": 0, … } }
 *   { "type": "item.added", "item": { "type": "agent_message_delta", "delta": "Part of the answer " } }
 *   { "type": "item.completed", "item": { "type": "agent_message", "text": "Full final answer." } }
 *
 * We parse each line, emit `shell` events for command_execution, and
 * `text_delta` events for agent_message / agent_message_delta items.
 * stderr is parsed only for `$ cmd` shell-prompt lines (legacy non-json
 * mode, plus a safety net).
 */
export class CodexParser implements StreamParser {
  private stdoutBuffer = '';
  private stderrBuffer = '';
  /** True once any `agent_message_delta` has been emitted with its text; we
   * then suppress the `text` field on the matching `item.completed` event to
   * avoid duplicating the final message in the live stream body. */
  private deltaTextEmitted = false;
  constructor(private previewLength: number) {}

  feed(chunk: string, stream: 'stdout' | 'stderr'): StreamEvent[] {
    if (stream === 'stderr') {
      return this.feedStderr(chunk);
    }
    return this.feedStdout(chunk);
  }

  private feedStderr(chunk: string): StreamEvent[] {
    this.stderrBuffer += chunk;
    const events: StreamEvent[] = [];
    let newlineIdx = this.stderrBuffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.stderrBuffer.slice(0, newlineIdx);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1);
      const shellMatch = line.match(/^\$\s+(.+?)\s*$/);
      if (shellMatch) {
        events.push({ kind: 'shell', command: summarizePreview(shellMatch[1], 120) });
      }
      newlineIdx = this.stderrBuffer.indexOf('\n');
    }
    return events;
  }

  private feedStdout(chunk: string): StreamEvent[] {
    this.stdoutBuffer += chunk;
    const events: StreamEvent[] = [];
    let newlineIdx = this.stdoutBuffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      const line = rawLine.trim();
      if (line.length > 0 && line.startsWith('{')) {
        const parsed = this.parseJsonLine(line);
        if (parsed) events.push(parsed);
      }
      // Non-JSON lines in stdout are not surfaced — they are usually session
      // chrome that codex prints before the JSON stream starts.
      newlineIdx = this.stdoutBuffer.indexOf('\n');
    }
    return events;
  }

  private parseJsonLine(line: string): StreamEvent | null {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    const item = obj?.item;
    if (!item || typeof item !== 'object') return null;
    if (obj.type === 'item.added' || obj.type === 'item.updated') {
      if (item.type === 'command_execution' && typeof item.command === 'string') {
        return { kind: 'shell', command: summarizePreview(item.command, 120) };
      }
      if (item.type === 'agent_message_delta' && typeof item.delta === 'string') {
        const preview = summarizePreview(item.delta, this.previewLength);
        if (preview.length > 0) {
          this.deltaTextEmitted = true;
          return { kind: 'text_delta', preview, text: item.delta };
        }
      }
      if (item.type === 'file_change' && typeof item.path === 'string') {
        return { kind: 'tool_use', tool: 'Edit', target: item.path };
      }
    }
    if (obj.type === 'item.completed') {
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        const preview = summarizePreview(item.text, this.previewLength);
        if (preview.length === 0) return null;
        // If deltas were already streamed, the live body already contains the
        // full text. Emit the event with a preview for the activity indicator
        // but omit `text` so the runner does not re-append the full message.
        if (this.deltaTextEmitted) {
          return { kind: 'text_delta', preview };
        }
        // No deltas seen — fall through and send the full text so the live
        // body gets something instead of staying empty until job close.
        return { kind: 'text_delta', preview, text: item.text };
      }
    }
    return null;
  }
}

/**
 * Generic fallback: emit a text_delta preview for any stdout chunk.
 * Stderr chunks are ignored unless they have the `$ cmd` shape (which many
 * CLI-driven providers adopt).
 */
export class GenericTextParser implements StreamParser {
  constructor(private previewLength: number) {}

  feed(chunk: string, stream: 'stdout' | 'stderr'): StreamEvent[] {
    if (stream === 'stderr') {
      const shellMatch = chunk.match(/^\$\s+(.+?)\s*$/m);
      if (shellMatch) return [{ kind: 'shell', command: summarizePreview(shellMatch[1], 120) }];
      return [];
    }
    const preview = summarizePreview(chunk, this.previewLength);
    if (preview.length === 0) return [];
    return [{ kind: 'text_delta', preview }];
  }
}
