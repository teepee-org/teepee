import * as crypto from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';

export interface UserRow {
  id: string;
  email: string;
  handle: string | null;
  role: string;
  status: string;
  revoked_at?: string | null;
}

const VALID_USER_ROLES = new Set(['owner', 'collaborator', 'observer']);

export function normalizeUserRole(role: string): string {
  const normalized = role === 'user' ? 'collaborator' : role;
  if (!VALID_USER_ROLES.has(normalized)) {
    throw new Error(`Invalid user role: ${role}. Use owner, collaborator, or observer`);
  }
  return normalized;
}

export function createUser(db: DatabaseType, email: string, role: string): void {
  db.prepare('INSERT INTO users (id, email, role) VALUES (?, ?, ?)').run(crypto.randomUUID(), email, normalizeUserRole(role));
}

export function activateUser(db: DatabaseType, email: string, handle: string): boolean {
  const result = db.prepare(
    `UPDATE users SET handle = ?, status = 'active', accepted_at = datetime('now') WHERE email = ? AND status = 'invited'`
  ).run(handle, email);
  return result.changes > 0;
}

export function getUser(db: DatabaseType, email: string): UserRow | undefined {
  return db.prepare('SELECT id, email, handle, role, status, revoked_at FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function getUserById(db: DatabaseType, id: string): UserRow | undefined {
  return db.prepare('SELECT id, email, handle, role, status, revoked_at FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByHandle(db: DatabaseType, handle: string): UserRow | undefined {
  return db.prepare('SELECT id, email, handle, role, status, revoked_at FROM users WHERE handle = ?').get(handle) as UserRow | undefined;
}

export function listUsers(db: DatabaseType): UserRow[] {
  return db.prepare('SELECT id, email, handle, role, status, revoked_at FROM users ORDER BY created_at').all() as UserRow[];
}

export function revokeUser(db: DatabaseType, email: string): boolean {
  const result = db.prepare("UPDATE users SET status = 'revoked' WHERE email = ?").run(email);
  return result.changes > 0;
}
