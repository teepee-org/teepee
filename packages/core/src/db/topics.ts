import type { Database as DatabaseType } from 'better-sqlite3';

export interface TopicRow {
  id: number;
  name: string;
  language: string | null;
  parent_topic_id: number | null;
  sort_order: number;
  archived: number;
  archived_at: string | null;
}

const TOPIC_COLS = 'id, name, language, parent_topic_id, sort_order, archived, archived_at';

export function createTopic(db: DatabaseType, name: string, parentTopicId?: number | null): number {
  const parentId = parentTopicId ?? null;
  const maxOrder = maxSiblingOrder(db, parentId);
  const result = parentId === null
    ? db.prepare('INSERT INTO topics (name, sort_order) VALUES (?, ?)').run(name, maxOrder + 1)
    : db.prepare('INSERT INTO topics (name, parent_topic_id, sort_order) VALUES (?, ?, ?)').run(name, parentId, maxOrder + 1);
  return Number(result.lastInsertRowid);
}

export function getTopic(db: DatabaseType, id: number): TopicRow | undefined {
  return db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE id = ?`).get(id) as TopicRow | undefined;
}

/**
 * Return non-archived topics in hierarchy order (parent before children, siblings by sort_order).
 * Uses a recursive CTE to produce a depth-first traversal.
 */
export function listTopics(db: DatabaseType): TopicRow[] {
  return db.prepare(`
    WITH RECURSIVE tree(id, name, language, parent_topic_id, sort_order, archived, archived_at, depth, path) AS (
      SELECT ${TOPIC_COLS}, 0 AS depth,
             CAST(printf('%020.6f_%010d', sort_order, id) AS TEXT) AS path
        FROM topics
       WHERE parent_topic_id IS NULL AND archived = 0
      UNION ALL
      SELECT t.id, t.name, t.language, t.parent_topic_id, t.sort_order, t.archived, t.archived_at,
             tree.depth + 1,
             tree.path || '/' || CAST(printf('%020.6f_%010d', t.sort_order, t.id) AS TEXT)
        FROM topics t
        JOIN tree ON t.parent_topic_id = tree.id
       WHERE t.archived = 0
    )
    SELECT id, name, language, parent_topic_id, sort_order, archived, archived_at FROM tree ORDER BY path
  `).all() as TopicRow[];
}

export function setTopicLanguage(db: DatabaseType, topicId: number, language: string): void {
  db.prepare('UPDATE topics SET language = ? WHERE id = ?').run(language, topicId);
}

export function archiveTopic(db: DatabaseType, topicId: number): void {
  db.prepare("UPDATE topics SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(topicId);
}

export function listArchivedTopics(db: DatabaseType): TopicRow[] {
  return db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE archived = 1 ORDER BY archived_at DESC`).all() as TopicRow[];
}

export function restoreTopic(db: DatabaseType, topicId: number): void {
  db.prepare('UPDATE topics SET archived = 0, archived_at = NULL WHERE id = ?').run(topicId);
}

// ── Rename ──

export function renameTopic(db: DatabaseType, topicId: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Topic name cannot be empty');
  db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(trimmed, topicId);
}

// ── Hierarchy helpers ──

/** Return [topicId, parentId, grandparentId, ..., rootId]. */
export function getTopicLineage(db: DatabaseType, topicId: number): number[] {
  const lineage: number[] = [];
  let current: number | null = topicId;
  while (current !== null) {
    lineage.push(current);
    const row = db.prepare('SELECT parent_topic_id FROM topics WHERE id = ?').get(current) as { parent_topic_id: number | null } | undefined;
    if (!row) break;
    current = row.parent_topic_id;
  }
  return lineage;
}

/** Check if `ancestorId` is an ancestor of `topicId` (or equal to it). */
export function isAncestorOf(db: DatabaseType, ancestorId: number, topicId: number): boolean {
  let current: number | null = topicId;
  while (current !== null) {
    if (current === ancestorId) return true;
    const row = db.prepare('SELECT parent_topic_id FROM topics WHERE id = ?').get(current) as { parent_topic_id: number | null } | undefined;
    if (!row) return false;
    current = row.parent_topic_id;
  }
  return false;
}

/** Get the max sort_order among children of parentId (null = root). */
function maxSiblingOrder(db: DatabaseType, parentId: number | null): number {
  const row = parentId === null
    ? db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM topics WHERE parent_topic_id IS NULL').get() as { m: number }
    : db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM topics WHERE parent_topic_id = ?').get(parentId) as { m: number };
  return row.m;
}

/** Move topic to root level, placed last. */
export function moveTopicToRoot(db: DatabaseType, topicId: number): void {
  const order = maxSiblingOrder(db, null) + 1;
  db.prepare('UPDATE topics SET parent_topic_id = NULL, sort_order = ? WHERE id = ?').run(order, topicId);
}

/** Move topic inside targetId as last child. */
export function moveTopicInto(db: DatabaseType, topicId: number, targetId: number): void {
  if (topicId === targetId) throw new Error('Cannot move a topic into itself');
  if (isAncestorOf(db, topicId, targetId)) throw new Error('Cannot move a topic into its own descendant');
  const target = getTopic(db, targetId);
  if (!target) throw new Error(`Topic #${targetId} not found`);
  const order = maxSiblingOrder(db, targetId) + 1;
  db.prepare('UPDATE topics SET parent_topic_id = ?, sort_order = ? WHERE id = ?').run(targetId, order, topicId);
}

/** Move topic to be a sibling of targetId, placed immediately before it. */
export function moveTopicBefore(db: DatabaseType, topicId: number, targetId: number): void {
  if (topicId === targetId) return; // no-op
  const target = getTopic(db, targetId);
  if (!target) throw new Error(`Topic #${targetId} not found`);
  if (isAncestorOf(db, topicId, targetId)) throw new Error('Cannot move a topic before its own descendant');

  // Find the sibling just before target (excluding the topic being moved)
  const prevRow = target.parent_topic_id === null
    ? db.prepare('SELECT sort_order FROM topics WHERE parent_topic_id IS NULL AND sort_order < ? AND id != ? ORDER BY sort_order DESC LIMIT 1').get(target.sort_order, topicId) as { sort_order: number } | undefined
    : db.prepare('SELECT sort_order FROM topics WHERE parent_topic_id = ? AND sort_order < ? AND id != ? ORDER BY sort_order DESC LIMIT 1').get(target.parent_topic_id, target.sort_order, topicId) as { sort_order: number } | undefined;

  const prevOrder = prevRow ? prevRow.sort_order : target.sort_order - 1;
  const newOrder = (prevOrder + target.sort_order) / 2;

  db.prepare('UPDATE topics SET parent_topic_id = ?, sort_order = ? WHERE id = ?').run(
    target.parent_topic_id ?? null, newOrder, topicId
  );
}

/** List direct children (non-archived) of a parent topic. Null parent = root topics. */
export function listTopicChildren(db: DatabaseType, parentId: number | null): TopicRow[] {
  if (parentId === null) {
    return db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE parent_topic_id IS NULL AND archived = 0 ORDER BY sort_order`)
      .all() as TopicRow[];
  }
  return db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE parent_topic_id = ? AND archived = 0 ORDER BY sort_order`)
    .all(parentId) as TopicRow[];
}

/**
 * Walk a path of topic names to find the leaf topic.
 * E.g. ["Backend", "API Design"] finds the "API Design" topic whose parent is "Backend" at root.
 */
export function findTopicByPath(db: DatabaseType, pathSegments: string[]): TopicRow | undefined {
  let parentId: number | null = null;
  let topic: TopicRow | undefined;
  for (const segment of pathSegments) {
    let row: TopicRow | undefined;
    if (parentId === null) {
      row = db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE parent_topic_id IS NULL AND name = ? AND archived = 0`).get(segment) as TopicRow | undefined;
    } else {
      row = db.prepare(`SELECT ${TOPIC_COLS} FROM topics WHERE parent_topic_id = ? AND name = ? AND archived = 0`).get(parentId, segment) as TopicRow | undefined;
    }
    if (!row) return undefined;
    topic = row;
    parentId = row.id;
  }
  return topic;
}

/** Move topic to be a sibling of targetId, placed immediately after it. */
export function moveTopicAfter(db: DatabaseType, topicId: number, targetId: number): void {
  if (topicId === targetId) return; // no-op
  const target = getTopic(db, targetId);
  if (!target) throw new Error(`Topic #${targetId} not found`);
  if (isAncestorOf(db, topicId, targetId)) throw new Error('Cannot move a topic after its own descendant');

  // Find the sibling just after target (excluding the topic being moved)
  const nextRow = target.parent_topic_id === null
    ? db.prepare('SELECT sort_order FROM topics WHERE parent_topic_id IS NULL AND sort_order > ? AND id != ? ORDER BY sort_order ASC LIMIT 1').get(target.sort_order, topicId) as { sort_order: number } | undefined
    : db.prepare('SELECT sort_order FROM topics WHERE parent_topic_id = ? AND sort_order > ? AND id != ? ORDER BY sort_order ASC LIMIT 1').get(target.parent_topic_id, target.sort_order, topicId) as { sort_order: number } | undefined;

  const nextOrder = nextRow ? nextRow.sort_order : target.sort_order + 1;
  const newOrder = (target.sort_order + nextOrder) / 2;

  db.prepare('UPDATE topics SET parent_topic_id = ?, sort_order = ? WHERE id = ?').run(
    target.parent_topic_id ?? null, newOrder, topicId
  );
}
