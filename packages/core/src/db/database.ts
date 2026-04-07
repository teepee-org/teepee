import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SCHEMA } from './schema.js';
import { runMigrations } from './migrate.js';

export function openDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}
