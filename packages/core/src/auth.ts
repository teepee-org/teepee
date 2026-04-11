import * as crypto from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getUser, getUserByHandle, getUserById, activateUser, emitEvent } from './db.js';

export interface AuthConfig {
  session_days: number;
  token_ttl_minutes: number;
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  session_days: 30,
  token_ttl_minutes: 60,
};

// --- Tokens ---

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createInviteToken(
  db: DatabaseType,
  email: string,
  ttlMinutes: number = DEFAULT_AUTH_CONFIG.token_ttl_minutes
): string {
  const user = getUser(db, email);
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO login_tokens (token, user_id, email, purpose, expires_at) VALUES (?, ?, ?, 'invite', ?)`
  ).run(token, user.id, email, expiresAt);
  return token;
}

export function createLoginToken(
  db: DatabaseType,
  email: string,
  ttlMinutes: number = DEFAULT_AUTH_CONFIG.token_ttl_minutes
): string {
  const user = getUser(db, email);
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO login_tokens (token, user_id, email, purpose, expires_at) VALUES (?, ?, ?, 'login', ?)`
  ).run(token, user.id, email, expiresAt);
  return token;
}

export interface TokenValidation {
  valid: boolean;
  userId?: string;
  email?: string;
  purpose?: string;
  error?: string;
}

export function validateToken(
  db: DatabaseType,
  token: string
): TokenValidation {
  const row = db
    .prepare(
      'SELECT token, user_id, email, purpose, expires_at, used_at FROM login_tokens WHERE token = ?'
    )
    .get(token) as any;

  if (!row) return { valid: false, error: 'Invalid token' };
  if (row.used_at) return { valid: false, error: 'Token already used' };
  if (new Date(row.expires_at) < new Date())
    return { valid: false, error: 'Token expired' };

  // Check user status
  const user = row.user_id ? getUserById(db, row.user_id) : getUser(db, row.email);
  if (!user) return { valid: false, error: 'User not found' };
  if (user.status === 'revoked') return { valid: false, error: 'User revoked' };

  return { valid: true, userId: user.id, email: user.email, purpose: row.purpose };
}

export function consumeToken(db: DatabaseType, token: string): void {
  db.prepare(
    `UPDATE login_tokens SET used_at = datetime('now') WHERE token = ?`
  ).run(token);
}

// --- Sessions ---

export function createSession(
  db: DatabaseType,
  email: string,
  sessionDays: number = DEFAULT_AUTH_CONFIG.session_days,
  userAgent?: string,
  ip?: string
): string {
  const user = getUser(db, email);
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  const sessionId = generateToken();
  const expiresAt = new Date(
    Date.now() + sessionDays * 24 * 60 * 60_000
  ).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, email, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, user.id, email, expiresAt, userAgent ?? null, ip ?? null);

  // Update last_login_at
  db.prepare(
    `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
  ).run(user.id);

  return sessionId;
}

export interface SessionUser {
  id: string;
  email: string;
  handle: string | null;
  role: string;
  status: string;
}

export function getSession(
  db: DatabaseType,
  sessionId: string
): SessionUser | null {
  const session = db
    .prepare(
      'SELECT user_id, email, expires_at FROM sessions WHERE id = ?'
    )
    .get(sessionId) as any;

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    // Expired — clean up
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  const user = session.user_id ? getUserById(db, session.user_id) : getUser(db, session.email);
  if (!user || user.status === 'revoked') {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  // Touch last_seen
  db.prepare(
    `UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`
  ).run(sessionId);

  return user;
}

export function deleteSession(db: DatabaseType, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function deleteUserSessions(db: DatabaseType, email: string): void {
  const user = getUser(db, email);
  if (user) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? OR email = ?').run(user.id, email);
    return;
  }
  db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
}

export function invalidateUserTokens(db: DatabaseType, email: string): void {
  const user = getUser(db, email);
  if (user) {
    db.prepare(
      `UPDATE login_tokens SET used_at = datetime('now') WHERE (user_id = ? OR email = ?) AND used_at IS NULL`
    ).run(user.id, email);
    return;
  }
  db.prepare(
    `UPDATE login_tokens SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL`
  ).run(email);
}

// --- Accept invite flow ---

export interface AcceptResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  user?: SessionUser;
}

export function acceptInvite(
  db: DatabaseType,
  token: string,
  handle: string,
  sessionDays?: number,
  userAgent?: string,
  ip?: string
): AcceptResult {
  // Validate handle
  if (!handle || handle.length < 2 || handle.length > 30) {
    return { ok: false, error: 'Handle must be 2-30 characters' };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(handle)) {
    return { ok: false, error: 'Handle must start with a letter and contain only letters, numbers, _ or -' };
  }

  // Check handle uniqueness
  const existing = getUserByHandle(db, handle);
  if (existing) {
    return { ok: false, error: 'Handle already taken' };
  }

  // Validate token
  const validation = validateToken(db, token);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const email = validation.email!;

  // Consume token
  consumeToken(db, token);

  // Activate user
  const user = getUser(db, email);
  if (user?.status === 'active') {
    // Already active — just create session
  } else {
    const activated = activateUser(db, email, handle);
    if (!activated) {
      return { ok: false, error: 'Could not activate user' };
    }
  }

  // Create session
  const sessionId = createSession(db, email, sessionDays, userAgent, ip);
  const updatedUser = getUser(db, email);

  return {
    ok: true,
    sessionId,
    user: updatedUser ?? undefined,
  };
}

// --- Owner auto-auth ---

export function ensureOwner(
  db: DatabaseType,
  ownerEmail: string
): void {
  const user = getUser(db, ownerEmail);
  if (!user) {
    db.prepare(
      `INSERT INTO users (id, email, role, status, handle, accepted_at)
       VALUES (?, ?, 'owner', 'active', 'owner', datetime('now'))`
    ).run(crypto.randomUUID(), ownerEmail);
  }
}

export function getOrCreateOwnerSession(
  db: DatabaseType,
  ownerEmail: string,
  sessionDays?: number
): string {
  // Check for existing valid session
  const existing = db
    .prepare(
      `SELECT s.id
       FROM sessions s
       JOIN users u ON u.id = s.user_id OR u.email = s.email
       WHERE u.email = ? AND s.expires_at > datetime('now')
       ORDER BY s.created_at DESC
       LIMIT 1`
    )
    .get(ownerEmail) as any;

  if (existing) {
    db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(existing.id);
    return existing.id;
  }

  return createSession(db, ownerEmail, sessionDays);
}

// --- Owner management ---

export function countOwners(db: DatabaseType): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'owner' AND status != 'revoked'`).get() as { cnt: number };
  return row.cnt;
}

function isLastOwner(db: DatabaseType, email: string): boolean {
  const user = getUser(db, email);
  if (!user || user.role !== 'owner' || user.status === 'revoked') return false;
  return countOwners(db) <= 1;
}

export function promoteToOwner(
  db: DatabaseType,
  email: string,
  actorEmail?: string
): { ok: boolean; error?: string } {
  const user = getUser(db, email);
  if (!user) return { ok: false, error: 'User not found' };
  if (user.role === 'owner') return { ok: false, error: 'Already an owner' };
  if (user.status !== 'active') return { ok: false, error: 'User is not active' };

  db.prepare(`UPDATE users SET role = 'owner' WHERE email = ?`).run(email);
  emitEvent(db, 'user.owner_promoted', null, JSON.stringify({ email, actor_email: actorEmail ?? null }));
  return { ok: true };
}

export function demoteFromOwner(
  db: DatabaseType,
  email: string,
  actorEmail?: string
): { ok: boolean; error?: string } {
  const user = getUser(db, email);
  if (!user) return { ok: false, error: 'User not found' };
  if (user.role !== 'owner') return { ok: false, error: 'User is not an owner' };
  if (isLastOwner(db, email)) return { ok: false, error: 'Cannot demote the last owner' };

  db.prepare(`UPDATE users SET role = 'collaborator' WHERE email = ?`).run(email);
  emitEvent(db, 'user.owner_demoted', null, JSON.stringify({ email, actor_email: actorEmail ?? null }));
  return { ok: true };
}

export function setUserRole(
  db: DatabaseType,
  email: string,
  role: 'owner' | 'collaborator' | 'observer',
  actorEmail?: string
): { ok: boolean; error?: string } {
  const user = getUser(db, email);
  if (!user) return { ok: false, error: 'User not found' };
  if (user.role === role) return { ok: true };
  if (user.status === 'revoked') return { ok: false, error: 'Cannot change role for a revoked user' };
  if (user.role === 'owner' && role !== 'owner' && isLastOwner(db, email)) {
    return { ok: false, error: 'Cannot demote the last owner' };
  }

  db.prepare(`UPDATE users SET role = ? WHERE email = ?`).run(role, email);
  emitEvent(db, 'user.role_changed', null, JSON.stringify({
    email,
    actor_email: actorEmail ?? null,
    old_role: user.role,
    new_role: role,
  }));
  return { ok: true };
}

// --- Revoke (extended) ---

export function revokeUserFull(
  db: DatabaseType,
  email: string
): boolean {
  const user = getUser(db, email);
  if (!user || user.status === 'revoked') return false;
  if (user.role === 'owner' && isLastOwner(db, email)) return false;

  db.prepare(
    `UPDATE users SET pre_revocation_status = status, status = 'revoked', revoked_at = datetime('now') WHERE email = ?`
  ).run(email);

  deleteUserSessions(db, email);
  invalidateUserTokens(db, email);
  return true;
}

export function reEnableUser(
  db: DatabaseType,
  email: string
): boolean {
  const row = db.prepare(
    `SELECT status, pre_revocation_status, role FROM users WHERE email = ?`
  ).get(email) as { status: string; pre_revocation_status: string | null; role: string } | undefined;

  if (!row || row.status !== 'revoked') return false;

  // Restore to pre-revocation status, fallback to 'active' for legacy rows
  const restoreTo = row.pre_revocation_status || 'active';

  db.prepare(
    `UPDATE users SET status = ?, pre_revocation_status = NULL, revoked_at = NULL WHERE email = ?`
  ).run(restoreTo, email);

  return true;
}

export function deleteUserPermanently(
  db: DatabaseType,
  email: string
): boolean {
  const user = getUser(db, email);
  if (!user) return false;
  if (user.role === 'owner' && isLastOwner(db, email)) return false;

  // Purge all user-linked data
  const userId = user.id;
  db.prepare('DELETE FROM sessions WHERE user_id = ? OR email = ?').run(userId, email);
  db.prepare('DELETE FROM login_tokens WHERE user_id = ? OR email = ?').run(userId, email);
  db.prepare('DELETE FROM permissions WHERE user_id = ? OR email = ?').run(userId, email);
  db.prepare('DELETE FROM usage_log WHERE user_id = ? OR user_email = ?').run(userId, email);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  return true;
}
