import { describe, it, expect } from 'vitest';
import {
  resolveTimeout,
  resolveKillGrace,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_KILL_GRACE_SECONDS,
} from './config.js';
import type { TeepeeConfig } from './config.js';

/**
 * Build a minimal TeepeeConfig just to exercise the resolve* helpers.
 * We only care about agents/providers shape here.
 */
function makeConfig(overrides: Partial<TeepeeConfig> = {}): TeepeeConfig {
  return {
    version: 2,
    mode: 'private',
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: '', hotkey: '', delay_ms: 0 } },
    server: {
      trust_proxy: false,
      cors_allowed_origins: [],
      auth_rate_limit_window_seconds: 60,
      auth_rate_limit_max_requests: 20,
    },
    providers: {},
    agents: {},
    roles: {},
    limits: {
      max_agents_per_message: 5,
      max_jobs_per_user_per_minute: 10,
      max_chain_depth: 2,
      max_total_jobs_per_chain: 10,
    },
    security: { sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] } },
    ...overrides,
  } as TeepeeConfig;
}

describe('resolveTimeout', () => {
  it('returns the default when neither agent nor provider set timeout_seconds', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p' } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveTimeout('coder', config)).toBe(DEFAULT_TIMEOUT_SECONDS * 1000);
  });

  it('respects the agent override', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', timeout_seconds: 60 } },
      agents: { coder: { provider: 'claude', timeout_seconds: 30 } },
    });
    expect(resolveTimeout('coder', config)).toBe(30_000);
  });

  it('falls back to the provider when the agent does not set timeout_seconds', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', timeout_seconds: 90 } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveTimeout('coder', config)).toBe(90_000);
  });

  it('treats agent.timeout_seconds: 0 as explicit opt-out (disabled)', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', timeout_seconds: 90 } },
      agents: { coder: { provider: 'claude', timeout_seconds: 0 } },
    });
    expect(resolveTimeout('coder', config)).toBe(0);
  });

  it('treats provider.timeout_seconds: 0 as explicit opt-out (disabled)', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', timeout_seconds: 0 } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveTimeout('coder', config)).toBe(0);
  });
});

describe('resolveKillGrace', () => {
  it('returns the default when kill_grace_seconds is not set', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p' } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveKillGrace('coder', config)).toBe(DEFAULT_KILL_GRACE_SECONDS * 1000);
  });

  it('respects the provider override', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', kill_grace_seconds: 2 } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveKillGrace('coder', config)).toBe(2_000);
  });

  it('treats kill_grace_seconds: 0 as "send SIGKILL immediately"', () => {
    const config = makeConfig({
      providers: { claude: { command: 'claude -p', kill_grace_seconds: 0 } },
      agents: { coder: { provider: 'claude' } },
    });
    expect(resolveKillGrace('coder', config)).toBe(0);
  });
});
