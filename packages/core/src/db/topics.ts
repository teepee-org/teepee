import type { Database as DatabaseType } from 'better-sqlite3';

export interface TopicRow {
  id: number;
  name: string;
  language: string | null;
  archived: number;
  divider_id: number | null;
  subject_id: number | null;
  position: number;
  archived_divider_id: number | null;
  archived_subject_id: number | null;
  archived_at: string | null;
}

export function createTopic(db: DatabaseType, name: string): number {
  const result = db.prepare('INSERT INTO topics (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

export function getTopic(db: DatabaseType, id: number): TopicRow | undefined {
  return db.prepare('SELECT id, name, language, archived, divider_id, subject_id, position, archived_divider_id, archived_subject_id, archived_at FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
}

export function listTopics(db: DatabaseType): TopicRow[] {
  return db.prepare('SELECT id, name, language, archived, divider_id, subject_id, position, archived_divider_id, archived_subject_id, archived_at FROM topics WHERE archived = 0 ORDER BY position, id').all() as TopicRow[];
}

export function setTopicLanguage(db: DatabaseType, topicId: number, language: string): void {
  db.prepare('UPDATE topics SET language = ? WHERE id = ?').run(language, topicId);
}

export function archiveTopic(db: DatabaseType, topicId: number): void {
  // Save current organization before archiving
  const topic = getTopic(db, topicId);
  if (topic) {
    db.prepare(
      'UPDATE topics SET archived = 1, archived_divider_id = divider_id, archived_subject_id = subject_id, archived_at = datetime(\'now\'), divider_id = NULL, subject_id = NULL WHERE id = ?'
    ).run(topicId);
  } else {
    db.prepare('UPDATE topics SET archived = 1 WHERE id = ?').run(topicId);
  }
}

export function moveTopic(db: DatabaseType, topicId: number, dividerId?: number | null, subjectId?: number | null): void {
  db.prepare('UPDATE topics SET divider_id = ?, subject_id = ? WHERE id = ?').run(
    dividerId ?? null, subjectId ?? null, topicId
  );
}

export function reorderTopics(db: DatabaseType, orderedIds: number[]): void {
  const stmt = db.prepare('UPDATE topics SET position = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, orderedIds[i]);
    }
  });
  tx();
}

export function listArchivedTopics(db: DatabaseType): TopicRow[] {
  return db.prepare('SELECT id, name, language, archived, divider_id, subject_id, position, archived_divider_id, archived_subject_id, archived_at FROM topics WHERE archived = 1 ORDER BY archived_at DESC').all() as TopicRow[];
}

export function restoreTopic(db: DatabaseType, topicId: number): void {
  const topic = getTopic(db, topicId);
  if (!topic) return;

  // Check if the original divider/subject still exist
  let dividerId: number | null = null;
  let subjectId: number | null = null;

  if (topic.archived_divider_id != null) {
    const divider = db.prepare('SELECT id FROM dividers WHERE id = ?').get(topic.archived_divider_id);
    if (divider) dividerId = topic.archived_divider_id;
  }
  if (topic.archived_subject_id != null) {
    const subject = db.prepare('SELECT id FROM subjects WHERE id = ?').get(topic.archived_subject_id);
    if (subject) subjectId = topic.archived_subject_id;
  }

  db.prepare(
    'UPDATE topics SET archived = 0, divider_id = ?, subject_id = ?, archived_divider_id = NULL, archived_subject_id = NULL, archived_at = NULL WHERE id = ?'
  ).run(dividerId, subjectId, topicId);
}
