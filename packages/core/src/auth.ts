import * as crypto from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getUser, getUserByHandle, activateUser } from './db.js';

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
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO login_tokens (token, email, purpose, expires_at) VALUES (?, ?, 'invite', ?)`
  ).run(token, email, expiresAt);
  return token;
}

export function createLoginToken(
  db: DatabaseType,
  email: string,
  ttlMinutes: number = DEFAULT_AUTH_CONFIG.token_ttl_minutes
): string {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO login_tokens (token, email, purpose, expires_at) VALUES (?, ?, 'login', ?)`
  ).run(token, email, expiresAt);
  return token;
}

export interface TokenValidation {
  valid: boolean;
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
      'SELECT token, email, purpose, expires_at, used_at FROM login_tokens WHERE token = ?'
    )
    .get(token) as any;

  if (!row) return { valid: false, error: 'Invalid token' };
  if (row.used_at) return { valid: false, error: 'Token already used' };
  if (new Date(row.expires_at) < new Date())
    return { valid: false, error: 'Token expired' };

  // Check user status
  const user = getUser(db, row.email);
  if (!user) return { valid: false, error: 'User not found' };
  if (user.status === 'revoked') return { valid: false, error: 'User revoked' };

  return { valid: true, email: row.email, purpose: row.purpose };
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
  const sessionId = generateToken();
  const expiresAt = new Date(
    Date.now() + sessionDays * 24 * 60 * 60_000
  ).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, email, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, email, expiresAt, userAgent ?? null, ip ?? null);

  // Update last_login_at
  db.prepare(
    `UPDATE users SET last_login_at = datetime('now') WHERE email = ?`
  ).run(email);

  return sessionId;
}

export interface SessionUser {
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
      'SELECT email, expires_at FROM sessions WHERE id = ?'
    )
    .get(sessionId) as any;

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    // Expired — clean up
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  const user = getUser(db, session.email);
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
  db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
}

export function invalidateUserTokens(db: DatabaseType, email: string): void {
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
      `INSERT INTO users (email, role, status, handle, accepted_at)
       VALUES (?, 'owner', 'active', 'owner', datetime('now'))`
    ).run(ownerEmail);
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
      `SELECT id FROM sessions WHERE email = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`
    )
    .get(ownerEmail) as any;

  if (existing) {
    db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(existing.id);
    return existing.id;
  }

  return createSession(db, ownerEmail, sessionDays);
}

// --- Revoke (extended) ---

export function revokeUserFull(
  db: DatabaseType,
  email: string
): boolean {
  const result = db
    .prepare("UPDATE users SET status = 'revoked' WHERE email = ?")
    .run(email);
  if (result.changes > 0) {
    deleteUserSessions(db, email);
    invalidateUserTokens(db, email);
    return true;
  }
  return false;
}
