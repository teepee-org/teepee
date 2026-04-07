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

  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const userColNames = new Set(userCols.map((c) => c.name));

  if (!userColNames.has('pre_revocation_status')) {
    db.exec(`ALTER TABLE users ADD COLUMN pre_revocation_status TEXT;`);
  }

  if (!userColNames.has('revoked_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN revoked_at TEXT;`);
  }
}
