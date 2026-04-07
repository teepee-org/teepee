import type { Database as DatabaseType } from 'better-sqlite3';

export interface TopicRow {
  id: number;
  name: string;
  language: string | null;
  archived: number;
  archived_at: string | null;
}

export function createTopic(db: DatabaseType, name: string): number {
  const result = db.prepare('INSERT INTO topics (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

export function getTopic(db: DatabaseType, id: number): TopicRow | undefined {
  return db.prepare('SELECT id, name, language, archived, archived_at FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
}

export function listTopics(db: DatabaseType): TopicRow[] {
  return db.prepare('SELECT id, name, language, archived, archived_at FROM topics WHERE archived = 0 ORDER BY id').all() as TopicRow[];
}

export function setTopicLanguage(db: DatabaseType, topicId: number, language: string): void {
  db.prepare('UPDATE topics SET language = ? WHERE id = ?').run(language, topicId);
}

export function archiveTopic(db: DatabaseType, topicId: number): void {
  db.prepare("UPDATE topics SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(topicId);
}

export function listArchivedTopics(db: DatabaseType): TopicRow[] {
  return db.prepare('SELECT id, name, language, archived, archived_at FROM topics WHERE archived = 1 ORDER BY archived_at DESC').all() as TopicRow[];
}

export function restoreTopic(db: DatabaseType, topicId: number): void {
  db.prepare('UPDATE topics SET archived = 0, archived_at = NULL WHERE id = ?').run(topicId);
}
