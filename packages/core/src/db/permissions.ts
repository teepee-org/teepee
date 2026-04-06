import type { Database as DatabaseType } from 'better-sqlite3';

export function setPermission(
  db: DatabaseType, email: string, topicId: number | null, targetAgent: string, allowed: boolean
): void {
  if (topicId === null) {
    db.prepare('DELETE FROM permissions WHERE email = ? AND topic_id IS NULL AND target_agent = ?').run(email, targetAgent);
  } else {
    db.prepare('DELETE FROM permissions WHERE email = ? AND topic_id = ? AND target_agent = ?').run(email, topicId, targetAgent);
  }
  db.prepare('INSERT INTO permissions (email, topic_id, target_agent, allowed) VALUES (?, ?, ?, ?)').run(email, topicId, targetAgent, allowed ? 1 : 0);
}

export function getPermissions(
  db: DatabaseType, email: string, topicId: number | null
): Array<{ target_agent: string; allowed: number; topic_id: number | null }> {
  return db.prepare(
    'SELECT target_agent, allowed, topic_id FROM permissions WHERE email = ? AND (topic_id = ? OR topic_id IS NULL)'
  ).all(email, topicId) as any;
}

export function setAlias(db: DatabaseType, topicId: number, alias: string, agentName: string): void {
  db.prepare('INSERT OR REPLACE INTO topic_aliases (topic_id, alias, agent_name) VALUES (?, ?, ?)').run(topicId, alias, agentName);
}

export function resolveAlias(db: DatabaseType, topicId: number, alias: string): string | undefined {
  const row = db.prepare('SELECT agent_name FROM topic_aliases WHERE topic_id = ? AND alias = ?').get(topicId, alias) as any;
  return row?.agent_name;
}

export function getTopicAliases(db: DatabaseType, topicId: number): Array<{ alias: string; agent_name: string }> {
  return db.prepare('SELECT alias, agent_name FROM topic_aliases WHERE topic_id = ?').all(topicId) as any;
}
