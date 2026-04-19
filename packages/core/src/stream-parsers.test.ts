import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamJsonParser,
  CodexParser,
  GenericTextParser,
  collectNonStreamingProviderWarnings,
  extractClaudeStreamJsonFinal,
  isClaudeStreamJson,
  isCodexExec,
  parserForCommand,
  type StreamEvent,
} from './stream-parsers.js';

describe('parserForCommand selection', () => {
  it('selects ClaudeStreamJsonParser for claude with stream-json flag', () => {
    const parser = parserForCommand('claude -p --output-format stream-json --verbose');
    expect(parser).toBeInstanceOf(ClaudeStreamJsonParser);
  });

  it('selects CodexParser for codex exec', () => {
    const parser = parserForCommand('codex exec --skip-git-repo-check');
    expect(parser).toBeInstanceOf(CodexParser);
  });

  it('falls back to GenericTextParser for unknown commands', () => {
    const parser = parserForCommand('ollama run qwen2.5-coder:7b');
    expect(parser).toBeInstanceOf(GenericTextParser);
  });

  it('does NOT pick Claude stream-json for plain claude -p', () => {
    const parser = parserForCommand('claude -p --permission-mode acceptEdits');
    expect(parser).not.toBeInstanceOf(ClaudeStreamJsonParser);
  });
});

describe('ClaudeStreamJsonParser', () => {
  it('emits tool_use and text events from a real Claude CLI assistant event', () => {
    const p = new ClaudeStreamJsonParser(60);
    const assistantEvent =
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'docs/notes.md' } },
          ],
        },
      }) + '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'The file contains the single word "hello".' },
          ],
        },
      }) + '\n';
    const events = p.feed(assistantEvent, 'stdout');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: 'tool_use', tool: 'Read', target: 'docs/notes.md' });
    expect(events[1].kind).toBe('text_delta');
    if (events[1].kind === 'text_delta') {
      expect(events[1].text).toBe('The file contains the single word "hello".');
      expect(events[1].preview).toContain('The file contains');
    }
  });

  it('ignores system, rate_limit_event and tool_result events', () => {
    const p = new ClaudeStreamJsonParser(60);
    const input =
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }) + '\n' +
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }) + '\n' +
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '...' }] } }) + '\n';
    expect(p.feed(input, 'stdout')).toEqual([]);
  });

  it('emits tool_use with target for Read (raw API event shape)', () => {
    const p = new ClaudeStreamJsonParser(60);
    const events = p.feed(
      JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'docs/notes.md' } },
      }) + '\n',
      'stdout'
    );
    expect(events).toEqual([{ kind: 'tool_use', tool: 'Read', target: 'docs/notes.md' }]);
  });

  it('emits tool_use with command preview for Bash', () => {
    const p = new ClaudeStreamJsonParser(60);
    const events = p.feed(
      JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash', input: { command: 'rg --files .' } },
      }) + '\n',
      'stdout'
    );
    expect(events).toEqual([{ kind: 'tool_use', tool: 'Bash', target: 'rg --files .' }]);
  });

  it('emits text_delta with truncated preview', () => {
    const p = new ClaudeStreamJsonParser(20);
    const longText = 'This is a fairly long text delta that should be truncated';
    const events = p.feed(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: longText },
      }) + '\n',
      'stdout'
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text_delta');
    if (events[0].kind === 'text_delta') {
      expect(events[0].preview.length).toBeLessThanOrEqual(21); // 20 chars + ellipsis
      expect(events[0].preview).toMatch(/…$/);
    }
  });

  it('buffers across chunks that split mid-JSON line', () => {
    const p = new ClaudeStreamJsonParser(60);
    const obj = {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Edit', input: { file_path: 'src/lib.ts' } },
    };
    const raw = JSON.stringify(obj) + '\n';
    const mid = Math.floor(raw.length / 2);
    const first = p.feed(raw.slice(0, mid), 'stdout');
    expect(first).toEqual([]);
    const second = p.feed(raw.slice(mid), 'stdout');
    expect(second).toEqual([{ kind: 'tool_use', tool: 'Edit', target: 'src/lib.ts' }]);
  });

  it('ignores invalid JSON lines without crashing', () => {
    const p = new ClaudeStreamJsonParser(60);
    const events = p.feed('not-json\n{"foo":"bar"}\n', 'stdout');
    expect(events).toEqual([]);
  });

  it('ignores stderr chunks entirely (they cannot corrupt the NDJSON buffer)', () => {
    const p = new ClaudeStreamJsonParser(60);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello.' }] },
    });
    // Send first half of the JSON line on stdout, a stderr warning, then the
    // rest on stdout. Without stream separation the buffer would concatenate
    // the warning mid-line and the JSON would fail to parse.
    const mid = Math.floor(line.length / 2);
    p.feed(line.slice(0, mid), 'stdout');
    expect(p.feed('⚠ rate-limit warning on stderr\n', 'stderr')).toEqual([]);
    const events = p.feed(line.slice(mid) + '\n', 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text_delta');
    if (events[0].kind === 'text_delta') {
      expect(events[0].text).toBe('Hello.');
    }
  });

  it('ignores empty text_delta', () => {
    const p = new ClaudeStreamJsonParser(60);
    const events = p.feed(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '   \n' },
      }) + '\n',
      'stdout'
    );
    expect(events).toEqual([]);
  });
});

describe('CodexParser', () => {
  it('emits shell on "$ cmd" stderr lines', () => {
    const p = new CodexParser(60);
    const events = p.feed('$ rg --files .\n', 'stderr');
    expect(events).toEqual([{ kind: 'shell', command: 'rg --files .' }]);
  });

  it('emits text_delta with full text from agent_message_delta NDJSON item', () => {
    const p = new CodexParser(40);
    const line = JSON.stringify({
      type: 'item.added',
      item: { type: 'agent_message_delta', delta: 'The project is a small library' },
    }) + '\n';
    const events = p.feed(line, 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text_delta');
    if (events[0].kind === 'text_delta') {
      expect(events[0].text).toBe('The project is a small library');
      expect(events[0].preview).toContain('The project');
    }
  });

  it('emits shell from command_execution NDJSON item', () => {
    const p = new CodexParser(60);
    const line = JSON.stringify({
      type: 'item.added',
      item: { type: 'command_execution', command: 'rg --files packages/core' },
    }) + '\n';
    expect(p.feed(line, 'stdout')).toEqual([
      { kind: 'shell', command: 'rg --files packages/core' },
    ]);
  });

  it('emits text_delta with text from item.completed when no deltas were seen', () => {
    const p = new CodexParser(40);
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Final answer here.' },
    }) + '\n';
    const events = p.feed(line, 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text_delta');
    if (events[0].kind === 'text_delta') {
      // No deltas streamed before the completed, so the completed event
      // carries the full text for the runner to append to the live body.
      expect(events[0].text).toBe('Final answer here.');
    }
  });

  it('strips text from item.completed when deltas already streamed (no duplication)', () => {
    const p = new CodexParser(40);
    const deltaLine =
      JSON.stringify({
        type: 'item.added',
        item: { type: 'agent_message_delta', delta: 'Part A ' },
      }) + '\n';
    const completedLine =
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Part A Part B.' },
      }) + '\n';
    const deltaEvents = p.feed(deltaLine, 'stdout');
    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0].kind).toBe('text_delta');
    if (deltaEvents[0].kind === 'text_delta') {
      expect(deltaEvents[0].text).toBe('Part A ');
    }
    const completedEvents = p.feed(completedLine, 'stdout');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].kind).toBe('text_delta');
    if (completedEvents[0].kind === 'text_delta') {
      // Preview is still populated for the activity indicator, but `text`
      // is omitted so the runner does not re-append the full message.
      expect(completedEvents[0].text).toBeUndefined();
      expect(completedEvents[0].preview).toContain('Part A Part B');
    }
  });

  it('ignores non-JSON stdout session chrome', () => {
    const p = new CodexParser(60);
    expect(p.feed('[2026-04-18T12:00:00] session started\n', 'stdout')).toEqual([]);
    expect(p.feed('not-json\n', 'stdout')).toEqual([]);
  });

  it('buffers partial stdout JSON lines across chunks', () => {
    const p = new CodexParser(40);
    const fullLine = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Done.' },
    }) + '\n';
    const mid = Math.floor(fullLine.length / 2);
    const first = p.feed(fullLine.slice(0, mid), 'stdout');
    expect(first).toEqual([]);
    const second = p.feed(fullLine.slice(mid), 'stdout');
    expect(second).toHaveLength(1);
    expect(second[0].kind).toBe('text_delta');
  });

  it('buffers partial stderr lines across chunks', () => {
    const p = new CodexParser(60);
    const first = p.feed('$ rg --files', 'stderr');
    expect(first).toEqual([]);
    const second = p.feed(' .\n', 'stderr');
    expect(second).toEqual([{ kind: 'shell', command: 'rg --files .' }]);
  });
});

describe('GenericTextParser', () => {
  it('emits text_delta on stdout with truncation', () => {
    const p = new GenericTextParser(10);
    const events = p.feed('some output that is too long', 'stdout');
    expect(events[0]?.kind).toBe('text_delta');
    if (events[0]?.kind === 'text_delta') {
      expect(events[0].preview.endsWith('…')).toBe(true);
    }
  });

  it('ignores stderr by default unless it looks like a shell prompt', () => {
    const p = new GenericTextParser(60);
    expect(p.feed('some warning on stderr\n', 'stderr')).toEqual([]);
    expect(p.feed('$ echo hi\n', 'stderr')).toEqual([{ kind: 'shell', command: 'echo hi' }]);
  });
});

describe('command shape helpers', () => {
  it('isClaudeStreamJson matches stream-json flag', () => {
    expect(isClaudeStreamJson('claude -p --output-format stream-json')).toBe(true);
    expect(isClaudeStreamJson('claude -p --output-format stream-json --verbose')).toBe(true);
    expect(isClaudeStreamJson('claude -p')).toBe(false);
    expect(isClaudeStreamJson('codex exec')).toBe(false);
  });

  it('isCodexExec matches codex exec', () => {
    expect(isCodexExec('codex exec --skip-git-repo-check')).toBe(true);
    expect(isCodexExec('/home/f/.nvm/.../codex exec')).toBe(true);
    expect(isCodexExec('claude -p')).toBe(false);
  });
});

describe('extractClaudeStreamJsonFinal', () => {
  it('returns the result field from a success event', () => {
    const buffer =
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The file contains hello.' }] } }) + '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', result: 'The file contains hello.', session_id: 'x' }) + '\n';
    expect(extractClaudeStreamJsonFinal(buffer)).toBe('The file contains hello.');
  });

  it('falls back to concatenated assistant text when no result event is present', () => {
    const buffer =
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part one. ' }] } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part two.' }] } }) + '\n';
    expect(extractClaudeStreamJsonFinal(buffer)).toBe('Part one. Part two.');
  });

  it('returns null when the buffer contains no extractable text', () => {
    const buffer =
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' +
      JSON.stringify({ type: 'rate_limit_event' }) + '\n';
    expect(extractClaudeStreamJsonFinal(buffer)).toBeNull();
  });
});

describe('collectNonStreamingProviderWarnings', () => {
  it('returns a warning for claude without stream-json', () => {
    const warns = collectNonStreamingProviderWarnings({
      claude: { command: 'claude -p --permission-mode acceptEdits' },
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('claude');
    expect(warns[0]).toContain('stream-json');
  });

  it('is silent when claude has stream-json', () => {
    const warns = collectNonStreamingProviderWarnings({
      claude: { command: 'claude -p --output-format stream-json --verbose' },
    });
    expect(warns).toEqual([]);
  });

  it('does not warn about codex', () => {
    const warns = collectNonStreamingProviderWarnings({
      codex: { command: 'codex exec' },
    });
    expect(warns).toEqual([]);
  });
});
