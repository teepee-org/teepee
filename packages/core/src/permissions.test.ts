import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, createUser, activateUser } from './db.js';
import { canTag, checkRateLimit, filterAllowedAgents, resolveUserAgentProfile } from './permissions.js';
import {
  promoteToOwner,
  demoteFromOwner,
  countOwners,
  revokeUserFull,
  deleteUserPermanently,
} from './auth.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AgentAccessProfile, LimitsConfig, TeepeeConfig } from './config.js';

const LIMITS: LimitsConfig = {
  max_agents_per_message: 5,
  max_jobs_per_user_per_minute: 10,
  max_chain_depth: 2,
  max_total_jobs_per_chain: 10,
};

let db: DatabaseType;

type RoleAgents = Record<string, AgentAccessProfile>;

function makeConfig(rolesInput: {
  owner: RoleAgents;
  collaborator: RoleAgents;
  observer: RoleAgents;
}): TeepeeConfig {
  return {
    version: 2,
    mode: 'private',
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 } },
    server: { trust_proxy: false, cors_allowed_origins: [], auth_rate_limit_window_seconds: 60, auth_rate_limit_max_requests: 20 },
    providers: { echo: { command: 'echo ok' } },
    agents: {
      coder: { provider: 'echo' },
      reviewer: { provider: 'echo' },
      deployer: { provider: 'echo' },
      architect: { provider: 'echo' },
    },
    roles: {
      owner: { superuser: true, agents: rolesInput.owner },
      collaborator: { capabilities: [], agents: rolesInput.collaborator },
      observer: { capabilities: [], agents: rolesInput.observer },
    },
    filesystem: {
      roots: [{ id: 'workspace', kind: 'workspace', path: '.', resolvedPath: process.cwd() }],
    },
    limits: LIMITS,
    security: { sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] } },
  };
}

beforeEach(() => {
  db = openDb(':memory:');

  // Create owner
  createUser(db, 'owner@test.com', 'owner');
  activateUser(db, 'owner@test.com', 'owner');

  // Create collaborator
  createUser(db, 'member@test.com', 'collaborator');
  activateUser(db, 'member@test.com', 'alice');

  // Create observer
  createUser(db, 'observer@test.com', 'observer');
  activateUser(db, 'observer@test.com', 'watcher');
});

describe('canTag', () => {
  it('owner allowed when the role-agent matrix maps the agent', () => {
    const config = makeConfig({ owner: { coder: 'trusted' }, collaborator: {}, observer: {} });
    expect(canTag(db, 'owner@test.com', 'coder', null, config)).toBe(true);
    expect(resolveUserAgentProfile(db, 'owner@test.com', 'coder', config)).toBe('trusted');
  });

  it('observer denied when the role-agent matrix omits the agent', () => {
    const config = makeConfig({ owner: { coder: 'trusted' }, collaborator: {}, observer: {} });
    expect(canTag(db, 'observer@test.com', 'coder', null, config)).toBe(false);
  });

  it('collaborator denied by default when no mapping exists', () => {
    const config = makeConfig({ owner: {}, collaborator: {}, observer: {} });
    expect(canTag(db, 'member@test.com', 'coder', null, config)).toBe(false);
  });

  it('collaborator allowed for readwrite mappings', () => {
    const config = makeConfig({ owner: {}, collaborator: { coder: 'readwrite', reviewer: 'readonly' }, observer: {} });
    expect(canTag(db, 'member@test.com', 'coder', null, config)).toBe(true);
    expect(canTag(db, 'member@test.com', 'reviewer', null, config)).toBe(true);
    expect(resolveUserAgentProfile(db, 'member@test.com', 'reviewer', config)).toBe('readonly');
  });

  it('trusted is controlled by the role-agent matrix, not hardcoded owner-only', () => {
    const config = makeConfig({ owner: {}, collaborator: { deployer: 'trusted' }, observer: {} });
    expect(canTag(db, 'member@test.com', 'deployer', null, config)).toBe(true);
    expect(resolveUserAgentProfile(db, 'member@test.com', 'deployer', config)).toBe('trusted');
  });

  it('unknown user denied', () => {
    const config = makeConfig({ owner: { coder: 'trusted' }, collaborator: { coder: 'readwrite' }, observer: {} });
    expect(canTag(db, 'unknown@test.com', 'coder', null, config)).toBe(false);
  });

  it('revoked user denied', () => {
    const config = makeConfig({ owner: {}, collaborator: { coder: 'readwrite' }, observer: {} });
    db.prepare("UPDATE users SET status = 'revoked' WHERE email = ?").run(
      'member@test.com'
    );
    expect(canTag(db, 'member@test.com', 'coder', null, config)).toBe(false);
  });
});

describe('filterAllowedAgents', () => {
  it('filters by role-agent matrix and returns effective profiles', () => {
    const config = makeConfig({ owner: {}, collaborator: { coder: 'readwrite' }, observer: {} });
    const result = filterAllowedAgents(
      db,
      'member@test.com',
      ['coder', 'reviewer'],
      1,
      LIMITS,
      config
    );
    expect(result.allowed).toEqual(['coder']);
    expect(result.denied).toEqual(['reviewer']);
    expect(result.rateLimited).toBe(false);
    expect(result.profiles).toEqual({ coder: 'readwrite' });
  });

  it('keeps trusted when the collaborator role explicitly grants it', () => {
    const config = makeConfig({ owner: {}, collaborator: { coder: 'readwrite', deployer: 'trusted' }, observer: {} });
    const result = filterAllowedAgents(
      db,
      'member@test.com',
      ['coder', 'deployer'],
      1,
      LIMITS,
      config
    );
    expect(result.allowed).toEqual(['coder', 'deployer']);
    expect(result.denied).toEqual([]);
    expect(result.profiles).toEqual({ coder: 'readwrite', deployer: 'trusted' });
  });
});

describe('multi-owner', () => {
  it('countOwners returns correct count', () => {
    expect(countOwners(db)).toBe(1);
  });

  it('promote collaborator to owner', () => {
    const result = promoteToOwner(db, 'member@test.com');
    expect(result.ok).toBe(true);
    expect(countOwners(db)).toBe(2);
  });

  it('demote owner to collaborator', () => {
    promoteToOwner(db, 'member@test.com');
    expect(countOwners(db)).toBe(2);
    const result = demoteFromOwner(db, 'owner@test.com');
    expect(result.ok).toBe(true);
    expect(countOwners(db)).toBe(1);
  });

  it('cannot demote last owner', () => {
    const result = demoteFromOwner(db, 'owner@test.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('last owner');
  });

  it('cannot revoke last owner', () => {
    const result = revokeUserFull(db, 'owner@test.com');
    expect(result).toBe(false);
  });

  it('can revoke non-last owner', () => {
    promoteToOwner(db, 'member@test.com');
    const result = revokeUserFull(db, 'owner@test.com');
    expect(result).toBe(true);
  });

  it('cannot revoke the only remaining active owner when another owner is revoked', () => {
    promoteToOwner(db, 'member@test.com');
    expect(revokeUserFull(db, 'owner@test.com')).toBe(true);
    expect(countOwners(db)).toBe(1);
    expect(revokeUserFull(db, 'member@test.com')).toBe(false);
    expect(countOwners(db)).toBe(1);
  });

  it('cannot delete last owner', () => {
    const result = deleteUserPermanently(db, 'owner@test.com');
    expect(result).toBe(false);
  });

  it('can delete non-last owner', () => {
    promoteToOwner(db, 'member@test.com');
    const result = deleteUserPermanently(db, 'owner@test.com');
    expect(result).toBe(true);
  });

  it('can delete a revoked owner without counting it as active owner coverage', () => {
    promoteToOwner(db, 'member@test.com');
    expect(revokeUserFull(db, 'owner@test.com')).toBe(true);
    expect(deleteUserPermanently(db, 'owner@test.com')).toBe(true);
    expect(countOwners(db)).toBe(1);
  });

  it('cannot delete the only remaining active owner when another owner is revoked', () => {
    promoteToOwner(db, 'member@test.com');
    expect(revokeUserFull(db, 'owner@test.com')).toBe(true);
    expect(deleteUserPermanently(db, 'member@test.com')).toBe(false);
    expect(countOwners(db)).toBe(1);
  });

  it('writes audit events for owner promotion and demotion', () => {
    expect(promoteToOwner(db, 'member@test.com', 'owner@test.com').ok).toBe(true);
    expect(demoteFromOwner(db, 'member@test.com', 'owner@test.com').ok).toBe(true);

    const events = db.prepare("SELECT kind, payload FROM events WHERE kind LIKE 'user.owner_%' ORDER BY id").all() as any[];
    expect(events.map((event) => event.kind)).toEqual(['user.owner_promoted', 'user.owner_demoted']);
    expect(JSON.parse(events[0].payload).actor_email).toBe('owner@test.com');
  });
});
