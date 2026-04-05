import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    handle TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'invited',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at TEXT,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent TEXT,
    ip TEXT
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    author_type TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    agent_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (message_id, agent_name)
);

CREATE TABLE IF NOT EXISTS invocation_batches (
    id INTEGER PRIMARY KEY,
    trigger_message_id INTEGER NOT NULL REFERENCES messages(id),
    chain_root_batch_id INTEGER,
    chain_depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES invocation_batches(id),
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    output_message_id INTEGER REFERENCES messages(id),
    error TEXT,
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    topic_id INTEGER,
    target_agent TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    UNIQUE (email, topic_id, target_agent)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_global
    ON permissions (email, target_agent) WHERE topic_id IS NULL;

CREATE TABLE IF NOT EXISTS topic_aliases (
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    alias TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    PRIMARY KEY (topic_id, alias)
);

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY,
    user_email TEXT,
    agent_name TEXT NOT NULL,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    topic_id INTEGER,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// --- Users ---

export function createUser(
  db: DatabaseType,
  email: string,
  role: string
): void {
  db.prepare(
    'INSERT INTO users (email, role) VALUES (?, ?)'
  ).run(email, role);
}

export function activateUser(
  db: DatabaseType,
  email: string,
  handle: string
): boolean {
  const result = db
    .prepare(
      `UPDATE users SET handle = ?, status = 'active', accepted_at = datetime('now')
       WHERE email = ? AND status = 'invited'`
    )
    .run(handle, email);
  return result.changes > 0;
}

export function getUser(
  db: DatabaseType,
  email: string
): { email: string; handle: string | null; role: string; status: string } | undefined {
  return db
    .prepare('SELECT email, handle, role, status FROM users WHERE email = ?')
    .get(email) as any;
}

export function getUserByHandle(
  db: DatabaseType,
  handle: string
): { email: string; handle: string; role: string; status: string } | undefined {
  return db
    .prepare('SELECT email, handle, role, status FROM users WHERE handle = ?')
    .get(handle) as any;
}

export function listUsers(
  db: DatabaseType
): Array<{ email: string; handle: string | null; role: string; status: string }> {
  return db
    .prepare('SELECT email, handle, role, status FROM users ORDER BY created_at')
    .all() as any;
}

export function revokeUser(db: DatabaseType, email: string): boolean {
  const result = db
    .prepare("UPDATE users SET status = 'revoked' WHERE email = ?")
    .run(email);
  return result.changes > 0;
}

// --- Topics ---

export function createTopic(db: DatabaseType, name: string): number {
  const result = db
    .prepare('INSERT INTO topics (name) VALUES (?)')
    .run(name);
  return Number(result.lastInsertRowid);
}

export function getTopic(
  db: DatabaseType,
  id: number
): { id: number; name: string; language: string | null; archived: number } | undefined {
  return db
    .prepare('SELECT id, name, language, archived FROM topics WHERE id = ?')
    .get(id) as any;
}

export function listTopics(
  db: DatabaseType
): Array<{ id: number; name: string; language: string | null; archived: number }> {
  return db
    .prepare('SELECT id, name, language, archived FROM topics WHERE archived = 0 ORDER BY id')
    .all() as any;
}

export function setTopicLanguage(
  db: DatabaseType,
  topicId: number,
  language: string
): void {
  db.prepare('UPDATE topics SET language = ? WHERE id = ?').run(language, topicId);
}

export function archiveTopic(db: DatabaseType, topicId: number): void {
  db.prepare('UPDATE topics SET archived = 1 WHERE id = ?').run(topicId);
}

// --- Messages ---

export interface MessageRow {
  id: number;
  topic_id: number;
  author_type: string;
  author_name: string;
  body: string;
  created_at: string;
}

export function insertMessage(
  db: DatabaseType,
  topicId: number,
  authorType: string,
  authorName: string,
  body: string
): number {
  const result = db
    .prepare(
      'INSERT INTO messages (topic_id, author_type, author_name, body) VALUES (?, ?, ?, ?)'
    )
    .run(topicId, authorType, authorName, body);
  const messageId = Number(result.lastInsertRowid);

  // Emit event
  emitEvent(db, 'message.created', topicId, JSON.stringify({ message_id: messageId, author_name: authorName }));

  return messageId;
}

export function getMessages(
  db: DatabaseType,
  topicId: number,
  limit: number = 50
): MessageRow[] {
  return db
    .prepare(
      `SELECT id, topic_id, author_type, author_name, body, created_at
       FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(topicId, limit)
    .reverse() as MessageRow[];
}

export function getRecentMessages(
  db: DatabaseType,
  topicId: number,
  count: number = 20
): MessageRow[] {
  return db
    .prepare(
      `SELECT id, topic_id, author_type, author_name, body, created_at
       FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(topicId, count)
    .reverse() as MessageRow[];
}

export function getMessageById(
  db: DatabaseType,
  id: number
): MessageRow | undefined {
  return db
    .prepare(
      'SELECT id, topic_id, author_type, author_name, body, created_at FROM messages WHERE id = ?'
    )
    .get(id) as MessageRow | undefined;
}

// --- Mentions ---

export function insertMention(
  db: DatabaseType,
  messageId: number,
  agentName: string,
  active: boolean
): void {
  db.prepare(
    'INSERT OR IGNORE INTO message_mentions (message_id, agent_name, active) VALUES (?, ?, ?)'
  ).run(messageId, agentName, active ? 1 : 0);
}

// --- Invocation Batches ---

export function createBatch(
  db: DatabaseType,
  triggerMessageId: number,
  chainRootBatchId: number | null,
  chainDepth: number
): number {
  const result = db
    .prepare(
      'INSERT INTO invocation_batches (trigger_message_id, chain_root_batch_id, chain_depth) VALUES (?, ?, ?)'
    )
    .run(triggerMessageId, chainRootBatchId, chainDepth);
  return Number(result.lastInsertRowid);
}

export function createJob(
  db: DatabaseType,
  batchId: number,
  agentName: string
): number {
  const result = db
    .prepare('INSERT INTO jobs (batch_id, agent_name) VALUES (?, ?)')
    .run(batchId, agentName);
  return Number(result.lastInsertRowid);
}

export function updateJobStatus(
  db: DatabaseType,
  jobId: number,
  status: string,
  extra?: { output_message_id?: number; error?: string }
): void {
  if (status === 'running') {
    db.prepare(
      "UPDATE jobs SET status = ?, started_at = datetime('now') WHERE id = ?"
    ).run(status, jobId);
  } else if (status === 'done' || status === 'failed') {
    db.prepare(
      `UPDATE jobs SET status = ?, completed_at = datetime('now'),
       output_message_id = COALESCE(?, output_message_id),
       error = COALESCE(?, error)
       WHERE id = ?`
    ).run(status, extra?.output_message_id ?? null, extra?.error ?? null, jobId);
  } else {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
  }
}

export function getJobsForBatch(
  db: DatabaseType,
  batchId: number
): Array<{ id: number; agent_name: string; status: string; output_message_id: number | null; error: string | null }> {
  return db
    .prepare('SELECT id, agent_name, status, output_message_id, error FROM jobs WHERE batch_id = ?')
    .all(batchId) as any;
}

export function countChainJobs(db: DatabaseType, chainRootBatchId: number): number {
  const result = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM jobs
       WHERE batch_id IN (
         SELECT id FROM invocation_batches
         WHERE chain_root_batch_id = ? OR id = ?
       )`
    )
    .get(chainRootBatchId, chainRootBatchId) as any;
  return result.cnt;
}

// --- Permissions ---

export function setPermission(
  db: DatabaseType,
  email: string,
  topicId: number | null,
  targetAgent: string,
  allowed: boolean
): void {
  // Delete existing then insert (handles NULL topic_id correctly)
  if (topicId === null) {
    db.prepare(
      'DELETE FROM permissions WHERE email = ? AND topic_id IS NULL AND target_agent = ?'
    ).run(email, targetAgent);
  } else {
    db.prepare(
      'DELETE FROM permissions WHERE email = ? AND topic_id = ? AND target_agent = ?'
    ).run(email, topicId, targetAgent);
  }
  db.prepare(
    'INSERT INTO permissions (email, topic_id, target_agent, allowed) VALUES (?, ?, ?, ?)'
  ).run(email, topicId, targetAgent, allowed ? 1 : 0);
}

export function getPermissions(
  db: DatabaseType,
  email: string,
  topicId: number | null
): Array<{ target_agent: string; allowed: number; topic_id: number | null }> {
  return db
    .prepare(
      `SELECT target_agent, allowed, topic_id FROM permissions
       WHERE email = ? AND (topic_id = ? OR topic_id IS NULL)`
    )
    .all(email, topicId) as any;
}

// --- Aliases ---

export function setAlias(
  db: DatabaseType,
  topicId: number,
  alias: string,
  agentName: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO topic_aliases (topic_id, alias, agent_name) VALUES (?, ?, ?)'
  ).run(topicId, alias, agentName);
}

export function resolveAlias(
  db: DatabaseType,
  topicId: number,
  alias: string
): string | undefined {
  const row = db
    .prepare('SELECT agent_name FROM topic_aliases WHERE topic_id = ? AND alias = ?')
    .get(topicId, alias) as any;
  return row?.agent_name;
}

export function getTopicAliases(
  db: DatabaseType,
  topicId: number
): Array<{ alias: string; agent_name: string }> {
  return db
    .prepare('SELECT alias, agent_name FROM topic_aliases WHERE topic_id = ?')
    .all(topicId) as any;
}

// --- Usage ---

export function logUsage(
  db: DatabaseType,
  email: string,
  agentName: string,
  jobId: number
): void {
  db.prepare(
    'INSERT INTO usage_log (user_email, agent_name, job_id) VALUES (?, ?, ?)'
  ).run(email, agentName, jobId);
}

export function countRecentJobs(
  db: DatabaseType,
  email: string,
  windowSeconds: number = 60
): number {
  const result = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM usage_log
       WHERE user_email = ? AND created_at > datetime('now', '-' || ? || ' seconds')`
    )
    .get(email, windowSeconds) as any;
  return result.cnt;
}

// --- Events ---

export function emitEvent(
  db: DatabaseType,
  kind: string,
  topicId: number | null,
  payload?: string
): number {
  const result = db
    .prepare('INSERT INTO events (kind, topic_id, payload) VALUES (?, ?, ?)')
    .run(kind, topicId, payload ?? null);
  return Number(result.lastInsertRowid);
}

export function getEventsAfter(
  db: DatabaseType,
  afterId: number,
  topicId?: number
): Array<{ id: number; kind: string; topic_id: number | null; payload: string | null; created_at: string }> {
  if (topicId !== undefined) {
    return db
      .prepare('SELECT * FROM events WHERE id > ? AND topic_id = ? ORDER BY id')
      .all(afterId, topicId) as any;
  }
  return db
    .prepare('SELECT * FROM events WHERE id > ? ORDER BY id')
    .all(afterId) as any;
}
