import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, createUser, activateUser, setPermission } from './db.js';
import { canTag, checkRateLimit, filterAllowedAgents } from './permissions.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { LimitsConfig } from './config.js';

const LIMITS: LimitsConfig = {
  max_agents_per_message: 5,
  max_jobs_per_user_per_minute: 10,
  max_chain_depth: 2,
  max_total_jobs_per_chain: 10,
};

let db: DatabaseType;

beforeEach(() => {
  db = openDb(':memory:');

  // Create owner
  createUser(db, 'owner@test.com', 'owner');
  activateUser(db, 'owner@test.com', 'owner');

  // Create member (role is 'user' but we need 'member' for compat)
  createUser(db, 'member@test.com', 'user');
  activateUser(db, 'member@test.com', 'alice');

  // Create observer
  createUser(db, 'observer@test.com', 'observer');
  activateUser(db, 'observer@test.com', 'watcher');
});

describe('canTag', () => {
  it('owner always allowed', () => {
    expect(canTag(db, 'owner@test.com', 'coder', null)).toBe(true);
  });

  it('observer always denied', () => {
    expect(canTag(db, 'observer@test.com', 'coder', null)).toBe(false);
  });

  it('member denied by default (no rules)', () => {
    expect(canTag(db, 'member@test.com', 'coder', null)).toBe(false);
  });

  it('member allowed with allow wildcard', () => {
    setPermission(db, 'member@test.com', null, '*', true);
    expect(canTag(db, 'member@test.com', 'coder', null)).toBe(true);
    expect(canTag(db, 'member@test.com', 'reviewer', null)).toBe(true);
  });

  it('member allowed with specific agent allow', () => {
    setPermission(db, 'member@test.com', null, 'coder', true);
    expect(canTag(db, 'member@test.com', 'coder', null)).toBe(true);
    expect(canTag(db, 'member@test.com', 'reviewer', null)).toBe(false);
  });

  it('deny specific beats allow wildcard', () => {
    setPermission(db, 'member@test.com', null, '*', true);
    setPermission(db, 'member@test.com', null, 'coder', false);
    expect(canTag(db, 'member@test.com', 'coder', null)).toBe(false);
    expect(canTag(db, 'member@test.com', 'reviewer', null)).toBe(true);
  });

  it('deny global beats allow topic', () => {
    setPermission(db, 'member@test.com', null, 'coder', false); // global deny
    setPermission(db, 'member@test.com', 1, 'coder', true); // topic allow
    expect(canTag(db, 'member@test.com', 'coder', 1)).toBe(false);
  });

  it('unknown user denied', () => {
    expect(canTag(db, 'unknown@test.com', 'coder', null)).toBe(false);
  });

  it('revoked user denied', () => {
    db.prepare("UPDATE users SET status = 'revoked' WHERE email = ?").run(
      'member@test.com'
    );
    setPermission(db, 'member@test.com', null, '*', true);
    expect(canTag(db, 'member@test.com', 'coder', null)).toBe(false);
  });
});

describe('filterAllowedAgents', () => {
  it('filters by permission', () => {
    setPermission(db, 'member@test.com', null, 'coder', true);
    const result = filterAllowedAgents(
      db,
      'member@test.com',
      ['coder', 'reviewer'],
      1,
      LIMITS
    );
    expect(result.allowed).toEqual(['coder']);
    expect(result.denied).toEqual(['reviewer']);
    expect(result.rateLimited).toBe(false);
  });
});
