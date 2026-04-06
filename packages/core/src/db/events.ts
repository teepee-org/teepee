import type { Database as DatabaseType } from 'better-sqlite3';

export function emitEvent(db: DatabaseType, kind: string, topicId: number | null, payload?: string): number {
  const result = db.prepare('INSERT INTO events (kind, topic_id, payload) VALUES (?, ?, ?)').run(kind, topicId, payload ?? null);
  return Number(result.lastInsertRowid);
}

export function getEventsAfter(
  db: DatabaseType, afterId: number, topicId?: number
): Array<{ id: number; kind: string; topic_id: number | null; payload: string | null; created_at: string }> {
  if (topicId !== undefined) {
    return db.prepare('SELECT * FROM events WHERE id > ? AND topic_id = ? ORDER BY id').all(afterId, topicId) as any;
  }
  return db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId) as any;
}

export function logUsage(db: DatabaseType, email: string, agentName: string, jobId: number): void {
  db.prepare('INSERT INTO usage_log (user_email, agent_name, job_id) VALUES (?, ?, ?)').run(email, agentName, jobId);
}

export function countRecentJobs(db: DatabaseType, email: string, windowSeconds: number = 60): number {
  const result = db.prepare(
    `SELECT COUNT(*) as cnt FROM usage_log WHERE user_email = ? AND created_at > datetime('now', '-' || ? || ' seconds')`
  ).get(email, windowSeconds) as any;
  return result.cnt;
}
