import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Run incremental migrations.
 * Safe to call multiple times — checks column existence before altering.
 */
export function runMigrations(db: DatabaseType): void {
  const topicCols = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[];
  const topicColNames = new Set(topicCols.map((c) => c.name));

  if (!topicColNames.has('archived_at')) {
    db.exec(`ALTER TABLE topics ADD COLUMN archived_at TEXT;`);
  }

  if (!topicColNames.has('parent_topic_id')) {
    db.exec(`ALTER TABLE topics ADD COLUMN parent_topic_id INTEGER REFERENCES topics(id);`);
  }

  if (!topicColNames.has('sort_order')) {
    db.exec(`ALTER TABLE topics ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;`);
  }

  // Backfill: give topics with degenerate sort_order a deterministic order based on id.
  // Runs unconditionally so databases that got the column before the backfill was added are fixed.
  db.exec(`UPDATE topics SET sort_order = id WHERE sort_order = 0;`);

  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const userColNames = new Set(userCols.map((c) => c.name));

  if (!userColNames.has('pre_revocation_status')) {
    db.exec(`ALTER TABLE users ADD COLUMN pre_revocation_status TEXT;`);
  }

  if (!userColNames.has('revoked_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN revoked_at TEXT;`);
  }
}
