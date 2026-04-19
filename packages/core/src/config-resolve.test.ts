import { describe, it, expect } from 'vitest';
import {
  resolveTimeout,
  resolveKillGrace,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_KILL_GRACE_SECONDS,
} from './config.js';
import type { TeepeeConfig } from './config.js';
import { createTestConfig } from './test-utils.js';

const makeConfig = (overrides: Partial<TeepeeConfig> = {}) => createTestConfig(overrides);

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
