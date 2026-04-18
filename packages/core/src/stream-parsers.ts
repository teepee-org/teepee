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
  | { kind: 'text_delta'; preview: string };

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
 * Events we care about:
 *   - assistant content_block_start with type=tool_use → { tool_use, tool, target? }
 *   - assistant content_block_delta with text_delta         → { text_delta }
 *
 * Chunks from the child process may split across JSON lines; we buffer by
 * newline and parse each complete line.
 */
export class ClaudeStreamJsonParser implements StreamParser {
  private buffer = '';
  constructor(private previewLength: number) {}

  feed(chunk: string, _stream: 'stdout' | 'stderr'): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        const parsed = this.tryParseLine(line);
        if (parsed) events.push(parsed);
      }
      newlineIdx = this.buffer.indexOf('\n');
    }
    return events;
  }

  private tryParseLine(line: string): StreamEvent | null {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    // content_block_start with tool_use
    if (obj?.type === 'content_block_start' && obj?.content_block?.type === 'tool_use') {
      const tool = String(obj.content_block.name ?? 'unknown');
      const input = obj.content_block.input ?? {};
      const target = extractToolTarget(tool, input);
      return { kind: 'tool_use', tool, target };
    }
    // content_block_delta with text (the model is writing)
    if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta' && typeof obj.delta.text === 'string') {
      const preview = summarizePreview(obj.delta.text, this.previewLength);
      if (preview.length === 0) return null;
      return { kind: 'text_delta', preview };
    }
    // Assistant message wrappers also expose nested content blocks.
    if (obj?.type === 'message' && Array.isArray(obj?.message?.content)) {
      for (const block of obj.message.content) {
        if (block?.type === 'tool_use') {
          const tool = String(block.name ?? 'unknown');
          const target = extractToolTarget(tool, block.input ?? {});
          return { kind: 'tool_use', tool, target };
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
          const preview = summarizePreview(block.text, this.previewLength);
          if (preview.length > 0) return { kind: 'text_delta', preview };
        }
      }
    }
    return null;
  }
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
 * Codex prints the agent session on stderr with lines like:
 *   $ rg --files .
 *   … (command output)
 *   $ cat packages/core/src/foo.ts
 *
 * And the final assistant message on stdout. We emit `shell` events for
 * stderr lines beginning with `$ ` and `text_delta` previews for stdout
 * bursts.
 */
export class CodexParser implements StreamParser {
  private stderrBuffer = '';
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
    const preview = summarizePreview(chunk, this.previewLength);
    if (preview.length === 0) return [];
    return [{ kind: 'text_delta', preview }];
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
