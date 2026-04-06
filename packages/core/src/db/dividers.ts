import type { Database as DatabaseType } from 'better-sqlite3';

export interface DividerRow {
  id: number;
  name: string;
  position: number;
}

export function createDivider(db: DatabaseType, name: string, position?: number): number {
  const pos = position ?? (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM dividers').get() as any).next;
  const result = db.prepare('INSERT INTO dividers (name, position) VALUES (?, ?)').run(name, pos);
  return Number(result.lastInsertRowid);
}

export function listDividers(db: DatabaseType): DividerRow[] {
  return db.prepare('SELECT id, name, position FROM dividers ORDER BY position').all() as DividerRow[];
}

export function renameDivider(db: DatabaseType, id: number, name: string): void {
  db.prepare('UPDATE dividers SET name = ? WHERE id = ?').run(name, id);
}

export function deleteDivider(db: DatabaseType, id: number): void {
  // Topics and subjects under this divider get divider_id = NULL
  db.prepare('UPDATE topics SET divider_id = NULL WHERE divider_id = ?').run(id);
  db.prepare('UPDATE subjects SET divider_id = NULL WHERE divider_id = ?').run(id);
  db.prepare('DELETE FROM dividers WHERE id = ?').run(id);
}

export function reorderDividers(db: DatabaseType, orderedIds: number[]): void {
  const stmt = db.prepare('UPDATE dividers SET position = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, orderedIds[i]);
    }
  });
  tx();
}
