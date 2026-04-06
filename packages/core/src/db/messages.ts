import type { Database as DatabaseType } from 'better-sqlite3';
import { emitEvent } from './events.js';

export interface MessageRow {
  id: number;
  topic_id: number;
  author_type: string;
  author_name: string;
  body: string;
  created_at: string;
}

export function insertMessage(
  db: DatabaseType, topicId: number, authorType: string, authorName: string, body: string
): number {
  const result = db.prepare(
    'INSERT INTO messages (topic_id, author_type, author_name, body) VALUES (?, ?, ?, ?)'
  ).run(topicId, authorType, authorName, body);
  const messageId = Number(result.lastInsertRowid);
  emitEvent(db, 'message.created', topicId, JSON.stringify({ message_id: messageId, author_name: authorName }));
  return messageId;
}

export function getMessages(db: DatabaseType, topicId: number, limit: number = 50): MessageRow[] {
  return db.prepare(
    'SELECT id, topic_id, author_type, author_name, body, created_at FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT ?'
  ).all(topicId, limit).reverse() as MessageRow[];
}

export function getRecentMessages(db: DatabaseType, topicId: number, count: number = 20): MessageRow[] {
  return db.prepare(
    'SELECT id, topic_id, author_type, author_name, body, created_at FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT ?'
  ).all(topicId, count).reverse() as MessageRow[];
}

export function getMessageById(db: DatabaseType, id: number): MessageRow | undefined {
  return db.prepare(
    'SELECT id, topic_id, author_type, author_name, body, created_at FROM messages WHERE id = ?'
  ).get(id) as MessageRow | undefined;
}

export function insertMention(db: DatabaseType, messageId: number, agentName: string, active: boolean): void {
  db.prepare(
    'INSERT OR IGNORE INTO message_mentions (message_id, agent_name, active) VALUES (?, ?, ?)'
  ).run(messageId, agentName, active ? 1 : 0);
}
