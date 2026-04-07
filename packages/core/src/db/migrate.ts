import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Run incremental migrations.
 * Safe to call multiple times — checks column existence before altering.
 */
export function runMigrations(db: DatabaseType): void {
  const columns = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has('archived_at')) {
    db.exec(`ALTER TABLE topics ADD COLUMN archived_at TEXT;`);
  }
}
