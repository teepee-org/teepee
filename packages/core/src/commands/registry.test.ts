import { describe, it, expect, vi } from 'vitest';
import { openDb, createTopic } from '../db.js';
import { executeCommand, getCommand, listCommands } from './registry.js';
import type { CommandContext } from './types.js';
import { createTestConfig, createTestUser } from '../test-utils.js';

function makeTestConfig() {
  return createTestConfig({
    roles: {
      owner: { superuser: true, agents: { coder: 'trusted' } },
      collaborator: {
        capabilities: [
          'files.workspace.access',
          'topics.create',
          'topics.rename',
          'topics.archive',
          'topics.restore',
          'topics.move',
          'topics.language.set',
          'messages.post',
        ],
        agents: { coder: 'readwrite' },
      },
      observer: { capabilities: ['files.workspace.access'], agents: {} },
    },
  });
}

function makeCtx(role: string = 'owner', topicId: number = 1): { ctx: CommandContext; broadcasts: any[] } {
  const db = openDb(':memory:');
  createTopic(db, 'test');
  const broadcasts: any[] = [];
  const ctx: CommandContext = {
    db,
    config: makeTestConfig(),
    user: createTestUser({ role }),
    topicId,
    broadcast: (_tid, evt) => broadcasts.push(evt),
  };
  return { ctx, broadcasts };
}

describe('command registry', () => {
  it('lists all built-in commands', () => {
    const cmds = listCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain('topic.language');
    expect(names).toContain('topic.rename');
    expect(names).toContain('topic.archive');
    expect(names).toContain('topic.alias');
  });

  it('getCommand returns undefined for unknown', () => {
    expect(getCommand('nope')).toBeUndefined();
  });

  it('executeCommand returns error for unknown command', () => {
    const { ctx } = makeCtx();
    const result = executeCommand('nope', ctx, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown command');
  });
});

describe('topic.language', () => {
  it('sets language and broadcasts', () => {
    const { ctx, broadcasts } = makeCtx();
    const result = executeCommand('topic.language', ctx, { language: 'it' });
    expect(result.ok).toBe(true);
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].text).toContain('it');
  });

  it('rejects missing language', () => {
    const { ctx } = makeCtx();
    const result = executeCommand('topic.language', ctx, {});
    expect(result.ok).toBe(false);
  });

  it('rejects observer', () => {
    const { ctx } = makeCtx('observer');
    const result = executeCommand('topic.language', ctx, { language: 'it' });
    expect(result.ok).toBe(false);
  });
});

describe('topic.rename', () => {
  it('renames and broadcasts', () => {
    const { ctx, broadcasts } = makeCtx();
    const result = executeCommand('topic.rename', ctx, { name: 'new-name' });
    expect(result.ok).toBe(true);
    expect(broadcasts[0].text).toContain('new-name');
  });
});

describe('topic.archive', () => {
  it('archives and broadcasts', () => {
    const { ctx, broadcasts } = makeCtx();
    const result = executeCommand('topic.archive', ctx, {});
    expect(result.ok).toBe(true);
    expect(broadcasts[0].text).toContain('archived');
  });
});

describe('topic.alias', () => {
  it('creates alias and broadcasts', () => {
    const { ctx, broadcasts } = makeCtx('owner');
    const result = executeCommand('topic.alias', ctx, { agent: 'coder', alias: 'c' });
    expect(result.ok).toBe(true);
    expect(broadcasts[0].text).toContain('@coder');
    expect(broadcasts[0].text).toContain('@c');
  });

  it('rejects non-owner', () => {
    const { ctx } = makeCtx('collaborator');
    const result = executeCommand('topic.alias', ctx, { agent: 'coder', alias: 'c' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Insufficient permissions');
  });
});
