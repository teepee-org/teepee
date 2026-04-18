import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamJsonParser,
  CodexParser,
  GenericTextParser,
  collectNonStreamingProviderWarnings,
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
  it('emits tool_use with target for Read', () => {
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

  it('emits text_delta on stdout bursts with preview', () => {
    const p = new CodexParser(40);
    const events = p.feed('The project is a small TypeScript library', 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text_delta');
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
