import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Run incremental migrations for sidebar organization feature.
 * Safe to call multiple times — checks column existence before altering.
 */
export function runMigrations(db: DatabaseType): void {
  const columns = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has('divider_id')) {
    db.exec(`
      ALTER TABLE topics ADD COLUMN divider_id INTEGER REFERENCES dividers(id) ON DELETE SET NULL;
      ALTER TABLE topics ADD COLUMN subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL;
      ALTER TABLE topics ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE topics ADD COLUMN archived_divider_id INTEGER;
      ALTER TABLE topics ADD COLUMN archived_subject_id INTEGER;
      ALTER TABLE topics ADD COLUMN archived_at TEXT;
    `);
  }
}
