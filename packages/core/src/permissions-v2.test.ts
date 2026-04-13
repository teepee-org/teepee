import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openDb, createUser, activateUser } from './db.js';
import { canTag, resolveUserAgentProfile, userHasCapability } from './permissions.js';
import type { LimitsConfig, TeepeeConfig } from './config.js';

const LIMITS: LimitsConfig = {
  max_agents_per_message: 5,
  max_jobs_per_user_per_minute: 10,
  max_chain_depth: 2,
  max_total_jobs_per_chain: 10,
};

let db: DatabaseType;

function makeConfig(): TeepeeConfig {
  return {
    version: 2,
    mode: 'shared',
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 } },
    server: { trust_proxy: false, cors_allowed_origins: [], auth_rate_limit_window_seconds: 60, auth_rate_limit_max_requests: 20 },
    providers: { echo: { command: 'echo ok' } },
    agents: {
      coder: { provider: 'echo' },
      reviewer: { provider: 'echo' },
    },
    roles: {
      owner: { superuser: true, agents: { coder: 'trusted', reviewer: 'trusted' } },
      admin: {
        capabilities: ['admin.view', 'messages.post', 'topics.create'],
        agents: { coder: 'readwrite', reviewer: 'readonly' },
      },
      qa: {
        capabilities: ['messages.post'],
        agents: { reviewer: 'trusted' },
      },
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
  createUser(db, 'owner@test.com', 'owner');
  activateUser(db, 'owner@test.com', 'owner');
  createUser(db, 'admin@test.com', 'admin');
  activateUser(db, 'admin@test.com', 'admin');
  createUser(db, 'qa@test.com', 'qa');
  activateUser(db, 'qa@test.com', 'qa');
  createUser(db, 'ghost@test.com', 'ghost');
  activateUser(db, 'ghost@test.com', 'ghost');
});

describe('permissions v2', () => {
  it('resolves capabilities and agent profiles for arbitrary roles', () => {
    const config = makeConfig();
    expect(userHasCapability(db, 'admin@test.com', 'admin.view', config)).toBe(true);
    expect(userHasCapability(db, 'qa@test.com', 'admin.view', config)).toBe(false);
    expect(resolveUserAgentProfile(db, 'qa@test.com', 'reviewer', config)).toBe('trusted');
    expect(resolveUserAgentProfile(db, 'qa@test.com', 'coder', config)).toBeNull();
    expect(canTag(db, 'admin@test.com', 'coder', null, config)).toBe(true);
  });

  it('denies orphaned roles not present in config', () => {
    const config = makeConfig();
    expect(userHasCapability(db, 'ghost@test.com', 'messages.post', config)).toBe(false);
    expect(canTag(db, 'ghost@test.com', 'reviewer', null, config)).toBe(false);
  });
});
