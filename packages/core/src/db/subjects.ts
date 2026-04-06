import type { Database as DatabaseType } from 'better-sqlite3';

export interface SubjectRow {
  id: number;
  name: string;
  divider_id: number | null;
  parent_id: number | null;
  position: number;
}

function getNestingDepth(db: DatabaseType, parentId: number | null): number {
  if (parentId == null) return 0;
  let depth = 0;
  let current: number | null = parentId;
  while (current != null) {
    depth++;
    const row = db.prepare('SELECT parent_id FROM subjects WHERE id = ?').get(current) as { parent_id: number | null } | undefined;
    current = row?.parent_id ?? null;
  }
  return depth;
}

export function createSubject(
  db: DatabaseType,
  name: string,
  dividerId?: number | null,
  parentId?: number | null,
  position?: number
): number {
  if (getNestingDepth(db, parentId ?? null) >= 2) {
    throw new Error('Maximum nesting depth (3 levels) exceeded');
  }
  const pos = position ?? (db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM subjects WHERE COALESCE(parent_id, 0) = ?'
  ).get(parentId ?? 0) as any).next;
  const result = db.prepare(
    'INSERT INTO subjects (name, divider_id, parent_id, position) VALUES (?, ?, ?, ?)'
  ).run(name, dividerId ?? null, parentId ?? null, pos);
  return Number(result.lastInsertRowid);
}

export function listSubjects(db: DatabaseType): SubjectRow[] {
  return db.prepare('SELECT id, name, divider_id, parent_id, position FROM subjects ORDER BY position').all() as SubjectRow[];
}

export function renameSubject(db: DatabaseType, id: number, name: string): void {
  db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(name, id);
}

export function moveSubject(db: DatabaseType, id: number, newDividerId?: number | null, newParentId?: number | null): void {
  if (newParentId != null && getNestingDepth(db, newParentId) >= 2) {
    throw new Error('Maximum nesting depth (3 levels) exceeded');
  }
  db.prepare('UPDATE subjects SET divider_id = ?, parent_id = ? WHERE id = ?').run(
    newDividerId ?? null, newParentId ?? null, id
  );
}

export function deleteSubject(db: DatabaseType, id: number): void {
  // Topics under this subject become unsorted
  db.prepare('UPDATE topics SET subject_id = NULL WHERE subject_id = ?').run(id);
  // CASCADE handles child subjects via FK, but we also need to unsort their topics
  const childIds = db.prepare('SELECT id FROM subjects WHERE parent_id = ?').all(id) as { id: number }[];
  for (const child of childIds) {
    deleteSubject(db, child.id);
  }
  db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
}

export function reorderSubjects(db: DatabaseType, parentId: number | null, orderedIds: number[]): void {
  const stmt = db.prepare('UPDATE subjects SET position = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, orderedIds[i]);
    }
  });
  tx();
}
