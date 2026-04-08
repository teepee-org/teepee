import { describe, it, expect } from 'vitest';
import { resolveExecutionPolicy, applyInsecureOverride, validateSandboxAvailability } from './execution-policy.js';
import type { SecurityConfig } from './config.js';

const defaultSecurity: SecurityConfig = {
  role_defaults: { owner: 'host', user: 'sandbox', observer: 'disabled' },
  sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
};

describe('resolveExecutionPolicy', () => {
  it('owner + host_allowed -> host', () => {
    const result = resolveExecutionPolicy('owner', 'host_allowed', defaultSecurity);
    expect(result.mode).toBe('host');
  });

  it('owner + sandbox_only -> sandbox', () => {
    const result = resolveExecutionPolicy('owner', 'sandbox_only', defaultSecurity);
    expect(result.mode).toBe('sandbox');
  });

  it('owner + disabled -> disabled', () => {
    const result = resolveExecutionPolicy('owner', 'disabled', defaultSecurity);
    expect(result.mode).toBe('disabled');
  });

  it('user + host_allowed -> sandbox', () => {
    const result = resolveExecutionPolicy('user', 'host_allowed', defaultSecurity);
    expect(result.mode).toBe('sandbox');
  });

  it('user + sandbox_only -> sandbox', () => {
    const result = resolveExecutionPolicy('user', 'sandbox_only', defaultSecurity);
    expect(result.mode).toBe('sandbox');
  });

  it('user + disabled -> disabled', () => {
    const result = resolveExecutionPolicy('user', 'disabled', defaultSecurity);
    expect(result.mode).toBe('disabled');
  });

  it('observer + any -> disabled', () => {
    expect(resolveExecutionPolicy('observer', 'host_allowed', defaultSecurity).mode).toBe('disabled');
    expect(resolveExecutionPolicy('observer', 'sandbox_only', defaultSecurity).mode).toBe('disabled');
    expect(resolveExecutionPolicy('observer', 'disabled', defaultSecurity).mode).toBe('disabled');
  });

  it('defaults to host_allowed when capability is undefined', () => {
    const result = resolveExecutionPolicy('owner', undefined, defaultSecurity);
    expect(result.mode).toBe('host');
  });

  it('respects custom role_defaults', () => {
    const custom: SecurityConfig = {
      ...defaultSecurity,
      role_defaults: { owner: 'sandbox', user: 'sandbox', observer: 'disabled' },
    };
    const result = resolveExecutionPolicy('owner', 'host_allowed', custom);
    expect(result.mode).toBe('sandbox');
  });

  it('includes reason in result', () => {
    const result = resolveExecutionPolicy('user', 'host_allowed', defaultSecurity);
    expect(result.reason).toContain('user');
    expect(result.reason).toContain('sandbox');
  });

  it('fails closed when role_defaults contains an invalid mode', () => {
    const corrupted: SecurityConfig = {
      ...defaultSecurity,
      role_defaults: { owner: 'host', user: 'sandbx' as any, observer: 'disabled' },
    };
    const result = resolveExecutionPolicy('user', 'host_allowed', corrupted);
    expect(result.mode).toBe('disabled');
    expect(result.reason).toContain('invalid');
    expect(result.reason).toContain('sandbx');
  });

  it('fails closed when role_defaults has empty string', () => {
    const corrupted: SecurityConfig = {
      ...defaultSecurity,
      role_defaults: { owner: '' as any, user: 'sandbox', observer: 'disabled' },
    };
    const result = resolveExecutionPolicy('owner', 'host_allowed', corrupted);
    expect(result.mode).toBe('disabled');
  });
});

describe('applyInsecureOverride', () => {
  it('promotes sandbox to host', () => {
    const result = applyInsecureOverride({ mode: 'sandbox', reason: 'agent is sandbox_only' });
    expect(result.mode).toBe('host');
    expect(result.reason).toContain('--insecure');
  });

  it('keeps host as host', () => {
    const result = applyInsecureOverride({ mode: 'host', reason: "role 'owner' defaults to 'host'" });
    expect(result.mode).toBe('host');
  });

  it('keeps disabled as disabled', () => {
    const result = applyInsecureOverride({ mode: 'disabled', reason: 'agent is disabled' });
    expect(result.mode).toBe('disabled');
  });
});

describe('validateSandboxAvailability', () => {
  it('returns null for host mode', () => {
    expect(validateSandboxAvailability('host', false)).toBeNull();
    expect(validateSandboxAvailability('host', true)).toBeNull();
  });

  it('returns null for sandbox mode when available', () => {
    expect(validateSandboxAvailability('sandbox', true)).toBeNull();
  });

  it('returns error for sandbox mode when unavailable', () => {
    const error = validateSandboxAvailability('sandbox', false);
    expect(error).toBeTruthy();
    expect(error).toContain('Sandbox required but not available');
  });

  it('returns null for disabled mode', () => {
    expect(validateSandboxAvailability('disabled', false)).toBeNull();
  });
});
