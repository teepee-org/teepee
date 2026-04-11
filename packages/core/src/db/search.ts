import type { Database as DatabaseType } from 'better-sqlite3';

export type SearchScope = 'all' | 'topic' | 'subtree';
export type SearchType = 'all' | 'topics' | 'messages';

export interface SearchOptions {
  scope?: SearchScope;
  topicId?: number;
  includeArchived?: boolean;
  limit?: number;
}

export interface TopicSearchResult {
  type: 'topic';
  topicId: number;
  topicName: string;
  topicPath: string;
  excerpt: string;
  rank: number;
}

export interface MessageSearchResult {
  type: 'message';
  messageId: number;
  topicId: number;
  topicName: string;
  topicPath: string;
  authorName: string;
  createdAt: string;
  excerpt: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  topics: TopicSearchResult[];
  messages: MessageSearchResult[];
}

export function searchAll(
  db: DatabaseType,
  query: string,
  type: SearchType = 'all',
  options: SearchOptions = {}
): SearchResponse {
  return {
    query,
    topics: type === 'messages' ? [] : searchTopics(db, query, options),
    messages: type === 'topics' ? [] : searchMessages(db, query, options),
  };
}

export function searchTopics(
  db: DatabaseType,
  query: string,
  options: SearchOptions = {}
): TopicSearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const scopedTopicIds = getScopedTopicIds(db, options);
  if (scopedTopicIds && scopedTopicIds.length === 0) return [];

  const params: unknown[] = [ftsQuery];
  const filters: string[] = [];
  if (!options.includeArchived) filters.push('t.archived = 0');
  if (scopedTopicIds) {
    filters.push(`t.id IN (${scopedTopicIds.map(() => '?').join(', ')})`);
    params.push(...scopedTopicIds);
  }
  params.push(safeLimit(options.limit, 20));

  const rows = db.prepare(`
    SELECT
      t.id AS topicId,
      t.name AS topicName,
      COALESCE(snippet(topics_fts, 0, '', '', '...', 12), t.name) AS excerpt,
      bm25(topics_fts) AS rank
    FROM topics_fts
    JOIN topics t ON topics_fts.rowid = t.id
    WHERE topics_fts MATCH ?
      ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
    ORDER BY rank, t.id DESC
    LIMIT ?
  `).all(...params) as Array<Omit<TopicSearchResult, 'type' | 'topicPath'>>;

  return rows.map((row) => ({
    type: 'topic',
    ...row,
    topicPath: getTopicPath(db, row.topicId),
  }));
}

export function searchMessages(
  db: DatabaseType,
  query: string,
  options: SearchOptions = {}
): MessageSearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const scopedTopicIds = getScopedTopicIds(db, options);
  if (scopedTopicIds && scopedTopicIds.length === 0) return [];

  const params: unknown[] = [ftsQuery];
  const filters: string[] = [];
  if (!options.includeArchived) filters.push('t.archived = 0');
  if (scopedTopicIds) {
    filters.push(`m.topic_id IN (${scopedTopicIds.map(() => '?').join(', ')})`);
    params.push(...scopedTopicIds);
  }
  params.push(safeLimit(options.limit, 30));

  const rows = db.prepare(`
    SELECT
      m.id AS messageId,
      m.topic_id AS topicId,
      t.name AS topicName,
      m.author_name AS authorName,
      m.created_at AS createdAt,
      COALESCE(snippet(messages_fts, 0, '', '', '...', 24), substr(m.body, 1, 240)) AS excerpt,
      bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    JOIN topics t ON t.id = m.topic_id
    WHERE messages_fts MATCH ?
      ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
    ORDER BY rank, m.id DESC
    LIMIT ?
  `).all(...params) as Array<Omit<MessageSearchResult, 'type' | 'topicPath'>>;

  return rows.map((row) => ({
    type: 'message',
    ...row,
    topicPath: getTopicPath(db, row.topicId),
  }));
}

function toFtsQuery(query: string): string | null {
  const tokens = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.slice(0, 8);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token) => `${token}*`).join(' AND ');
}

function safeLimit(limit: number | undefined, fallback: number): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function getScopedTopicIds(db: DatabaseType, options: SearchOptions): number[] | null {
  if (!options.topicId || !options.scope || options.scope === 'all') return null;
  if (options.scope === 'topic') return [options.topicId];

  const rows = db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM topics WHERE id = ?
      UNION ALL
      SELECT t.id
        FROM topics t
        JOIN subtree s ON t.parent_topic_id = s.id
    )
    SELECT id FROM subtree
  `).all(options.topicId) as { id: number }[];
  return rows.map((row) => row.id);
}

function getTopicPath(db: DatabaseType, topicId: number): string {
  const row = db.prepare(`
    WITH RECURSIVE ancestors(id, name, parent_topic_id, depth) AS (
      SELECT id, name, parent_topic_id, 0 AS depth FROM topics WHERE id = ?
      UNION ALL
      SELECT t.id, t.name, t.parent_topic_id, ancestors.depth + 1
        FROM topics t
        JOIN ancestors ON t.id = ancestors.parent_topic_id
    )
    SELECT group_concat(name, ' / ') AS path
      FROM (SELECT name FROM ancestors ORDER BY depth DESC)
  `).get(topicId) as { path: string | null } | undefined;

  return row?.path ?? `#${topicId}`;
}
