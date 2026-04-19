import type { TeepeeConfig } from './config.js';

/**
 * Build a minimal TeepeeConfig for tests. Overrides shallow-merge with the
 * default. Tests that need deep customization should pass full sub-objects
 * (e.g. providers, agents, roles) rather than relying on per-field merging.
 */
export function createTestConfig(overrides: Partial<TeepeeConfig> = {}): TeepeeConfig {
  const base: TeepeeConfig = {
    version: 2,
    mode: 'private',
    teepee: {
      name: 'test',
      language: 'en',
      demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 },
    },
    server: {
      trust_proxy: false,
      cors_allowed_origins: [],
      auth_rate_limit_window_seconds: 60,
      auth_rate_limit_max_requests: 20,
    },
    providers: { echo: { command: 'echo ok' } },
    agents: { coder: { provider: 'echo' } },
    roles: {
      owner: { superuser: true, agents: { coder: 'trusted' } },
    },
    filesystem: {
      roots: [{ id: 'workspace', kind: 'workspace', path: '.', resolvedPath: process.cwd() }],
    },
    limits: {
      max_agents_per_message: 5,
      max_jobs_per_user_per_minute: 10,
      max_chain_depth: 2,
      max_total_jobs_per_chain: 10,
    },
    security: {
      sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
    },
  };
  return { ...base, ...overrides };
}

export interface TestUserOverrides {
  id?: string;
  email?: string;
  handle?: string | null;
  role?: string;
  status?: string;
}

/**
 * Build a minimal user object compatible with CommandContext.user / SessionUser.
 * Defaults to an active owner.
 */
export function createTestUser(overrides: TestUserOverrides = {}) {
  return {
    id: 'usr_test',
    email: 'test@test.com',
    handle: 'tester',
    role: 'owner',
    status: 'active',
    ...overrides,
  };
}
