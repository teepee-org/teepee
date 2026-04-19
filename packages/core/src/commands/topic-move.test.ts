import { describe, it, expect } from 'vitest';
import { openDb, createTopic, getTopic, listTopics, runMigrations } from '../db.js';
import { SCHEMA } from '../db.js';
import { executeCommand, listCommands } from './registry.js';
import type { CommandContext } from './types.js';
import type { Database as DatabaseType } from 'better-sqlite3';
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

function setup() {
  const db = openDb(':memory:');
  const broadcasts: any[] = [];
  const config = makeTestConfig();
  const makeCtx = (topicId: number, role = 'owner'): CommandContext => ({
    db,
    config,
    user: createTestUser({ role }),
    topicId,
    broadcast: (_tid, evt) => broadcasts.push(evt),
  });
  return { db, broadcasts, makeCtx };
}

describe('topic.move.root', () => {
  it('moves a nested topic to root', () => {
    const { db, makeCtx } = setup();
    const parentId = createTopic(db, 'Parent');
    const childId = createTopic(db, 'Child');
    // Nest child under parent
    executeCommand('topic.move.into', makeCtx(childId), { targetId: parentId });
    expect(getTopic(db, childId)!.parent_topic_id).toBe(parentId);

    // Move to root
    const result = executeCommand('topic.move.root', makeCtx(childId), {});
    expect(result.ok).toBe(true);
    expect(getTopic(db, childId)!.parent_topic_id).toBeNull();
  });

  it('is a no-op for already-root topics', () => {
    const { db, makeCtx } = setup();
    const id = createTopic(db, 'Root');
    const result = executeCommand('topic.move.root', makeCtx(id), {});
    expect(result.ok).toBe(true);
    expect(getTopic(db, id)!.parent_topic_id).toBeNull();
  });
});

describe('topic.move.into', () => {
  it('moves topic inside another topic', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const result = executeCommand('topic.move.into', makeCtx(a), { targetId: b });
    expect(result.ok).toBe(true);
    expect(getTopic(db, a)!.parent_topic_id).toBe(b);
  });

  it('rejects moving topic into itself', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const result = executeCommand('topic.move.into', makeCtx(a), { targetId: a });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('itself');
  });

  it('rejects cycles — moving parent into child', () => {
    const { db, makeCtx } = setup();
    const parent = createTopic(db, 'Parent');
    const child = createTopic(db, 'Child');
    executeCommand('topic.move.into', makeCtx(child), { targetId: parent });

    const result = executeCommand('topic.move.into', makeCtx(parent), { targetId: child });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('descendant');
  });

  it('rejects cycles — moving grandparent into grandchild', () => {
    const { db, makeCtx } = setup();
    const gp = createTopic(db, 'GP');
    const p = createTopic(db, 'P');
    const c = createTopic(db, 'C');
    executeCommand('topic.move.into', makeCtx(p), { targetId: gp });
    executeCommand('topic.move.into', makeCtx(c), { targetId: p });

    const result = executeCommand('topic.move.into', makeCtx(gp), { targetId: c });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('descendant');
  });

  it('rejects invalid target id', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const result = executeCommand('topic.move.into', makeCtx(a), { targetId: 9999 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects missing target id', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const result = executeCommand('topic.move.into', makeCtx(a), {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing');
  });
});

describe('topic.move.before', () => {
  it('moves topic before target, inheriting parent', () => {
    const { db, makeCtx } = setup();
    const parent = createTopic(db, 'Parent');
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    // Nest A and B under parent
    executeCommand('topic.move.into', makeCtx(a), { targetId: parent });
    executeCommand('topic.move.into', makeCtx(b), { targetId: parent });

    // Create C at root, move it before B (should become child of parent)
    const c = createTopic(db, 'C');
    const result = executeCommand('topic.move.before', makeCtx(c), { targetId: b });
    expect(result.ok).toBe(true);

    const cRow = getTopic(db, c)!;
    const bRow = getTopic(db, b)!;
    expect(cRow.parent_topic_id).toBe(parent);
    expect(cRow.sort_order).toBeLessThan(bRow.sort_order);
  });

  it('cross-level move: moves from nested to root before a root topic', () => {
    const { db, makeCtx } = setup();
    const root1 = createTopic(db, 'Root1');
    const root2 = createTopic(db, 'Root2');
    const nested = createTopic(db, 'Nested');
    executeCommand('topic.move.into', makeCtx(nested), { targetId: root1 });

    const result = executeCommand('topic.move.before', makeCtx(nested), { targetId: root2 });
    expect(result.ok).toBe(true);
    expect(getTopic(db, nested)!.parent_topic_id).toBeNull();
    expect(getTopic(db, nested)!.sort_order).toBeLessThan(getTopic(db, root2)!.sort_order);
  });
});

describe('topic.move.after', () => {
  it('moves topic after target, inheriting parent', () => {
    const { db, makeCtx } = setup();
    const parent = createTopic(db, 'Parent');
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    executeCommand('topic.move.into', makeCtx(a), { targetId: parent });
    executeCommand('topic.move.into', makeCtx(b), { targetId: parent });

    const c = createTopic(db, 'C');
    const result = executeCommand('topic.move.after', makeCtx(c), { targetId: a });
    expect(result.ok).toBe(true);

    const cRow = getTopic(db, c)!;
    const aRow = getTopic(db, a)!;
    const bRow = getTopic(db, b)!;
    expect(cRow.parent_topic_id).toBe(parent);
    expect(cRow.sort_order).toBeGreaterThan(aRow.sort_order);
    expect(cRow.sort_order).toBeLessThan(bRow.sort_order);
  });

  it('cross-level move: moves from nested to root after a root topic', () => {
    const { db, makeCtx } = setup();
    const root1 = createTopic(db, 'Root1');
    const root2 = createTopic(db, 'Root2');
    const nested = createTopic(db, 'Nested');
    executeCommand('topic.move.into', makeCtx(nested), { targetId: root1 });

    const result = executeCommand('topic.move.after', makeCtx(nested), { targetId: root1 });
    expect(result.ok).toBe(true);
    expect(getTopic(db, nested)!.parent_topic_id).toBeNull();
    expect(getTopic(db, nested)!.sort_order).toBeGreaterThan(getTopic(db, root1)!.sort_order);
    expect(getTopic(db, nested)!.sort_order).toBeLessThan(getTopic(db, root2)!.sort_order);
  });
});

describe('topic ordering and listTopics', () => {
  it('returns topics in hierarchy order', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const c = createTopic(db, 'C');

    // Nest B under A
    executeCommand('topic.move.into', makeCtx(b), { targetId: a });

    const topics = listTopics(db);
    const names = topics.map((t) => t.name);
    // A should come first, then B (child of A), then C
    expect(names).toEqual(['A', 'B', 'C']);
  });

  it('preserves sibling order after multiple moves', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const c = createTopic(db, 'C');
    const d = createTopic(db, 'D');

    // Move D before B
    executeCommand('topic.move.before', makeCtx(d), { targetId: b });

    const topics = listTopics(db);
    const names = topics.map((t) => t.name);
    // Order: A, D, B, C
    expect(names).toEqual(['A', 'D', 'B', 'C']);
  });

  it('deeply nested topics appear in correct order', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const c = createTopic(db, 'C');

    executeCommand('topic.move.into', makeCtx(b), { targetId: a });
    executeCommand('topic.move.into', makeCtx(c), { targetId: b });

    const topics = listTopics(db);
    const names = topics.map((t) => t.name);
    expect(names).toEqual(['A', 'B', 'C']);
    expect(topics[1].parent_topic_id).toBe(a);
    expect(topics[2].parent_topic_id).toBe(b);
  });
});

describe('permission checks', () => {
  it('rejects observer for move commands', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const result = executeCommand('topic.move.into', makeCtx(a, 'observer'), { targetId: b });
    expect(result.ok).toBe(false);
  });

  it('allows collaborator role for move commands', () => {
    const { db, makeCtx } = setup();
    const a = createTopic(db, 'A');
    const b = createTopic(db, 'B');
    const result = executeCommand('topic.move.into', makeCtx(a, 'collaborator'), { targetId: b });
    expect(result.ok).toBe(true);
  });
});

describe('command registry includes move commands', () => {
  it('lists all four move commands', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('topic.move.root');
    expect(names).toContain('topic.move.into');
    expect(names).toContain('topic.move.before');
    expect(names).toContain('topic.move.after');
  });
});

describe('migration backfill for sort_order', () => {
  it('gives legacy topics deterministic sort_order based on id', () => {
    // Simulate a legacy database: create schema WITHOUT sort_order/parent_topic_id
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Use the old schema (without parent_topic_id and sort_order)
    const oldSchema = SCHEMA.replace(
      /parent_topic_id INTEGER REFERENCES topics\(id\),\s*\n\s*sort_order REAL NOT NULL DEFAULT 0,\s*\n/,
      ''
    );
    db.exec(oldSchema);

    // Insert topics the old way (no sort_order column)
    db.prepare('INSERT INTO topics (name) VALUES (?)').run('Alpha');
    db.prepare('INSERT INTO topics (name) VALUES (?)').run('Beta');
    db.prepare('INSERT INTO topics (name) VALUES (?)').run('Gamma');

    // Run migration
    runMigrations(db);

    // Verify backfill: sort_order should equal id
    const rows = db.prepare('SELECT id, sort_order FROM topics ORDER BY id').all() as { id: number; sort_order: number }[];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.sort_order).toBe(row.id);
    }

    // Verify listTopics returns them in id order (deterministic)
    const topics = listTopics(db);
    expect(topics.map((t) => t.name)).toEqual(['Alpha', 'Beta', 'Gamma']);

    db.close();
  });
});

describe('createTopic with parentTopicId', () => {
  it('creates a root topic when parentTopicId is omitted', () => {
    const { db } = setup();
    const id = createTopic(db, 'Root');
    const topic = getTopic(db, id);
    expect(topic!.parent_topic_id).toBeNull();
  });

  it('creates a child topic when parentTopicId is given', () => {
    const { db } = setup();
    const parentId = createTopic(db, 'Parent');
    const childId = createTopic(db, 'Child', parentId);
    const child = getTopic(db, childId);
    expect(child!.parent_topic_id).toBe(parentId);
  });

  it('preserves sibling ordering under parent', () => {
    const { db } = setup();
    const parentId = createTopic(db, 'Parent');
    const c1 = createTopic(db, 'First', parentId);
    const c2 = createTopic(db, 'Second', parentId);
    const t1 = getTopic(db, c1)!;
    const t2 = getTopic(db, c2)!;
    expect(t2.sort_order).toBeGreaterThan(t1.sort_order);
  });

  it('child topics appear under parent in listTopics', () => {
    const { db } = setup();
    const parentId = createTopic(db, 'Parent');
    createTopic(db, 'Child A', parentId);
    createTopic(db, 'Child B', parentId);
    const topics = listTopics(db);
    const names = topics.map((t) => t.name);
    expect(names.indexOf('Child A')).toBeGreaterThan(names.indexOf('Parent'));
    expect(names.indexOf('Child B')).toBeGreaterThan(names.indexOf('Parent'));
  });
});
