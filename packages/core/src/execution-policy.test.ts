import { describe, it, expect } from 'vitest';
import { resolveExecutionPolicy, validateSandboxAvailability } from './execution-policy.js';

describe('resolveExecutionPolicy', () => {
  it('denies missing role-agent mapping', () => {
    const result = resolveExecutionPolicy(null);
    expect(result.mode).toBe('disabled');
    expect(result.reason).toContain('not mapped');
  });

  it('maps readonly to a read-only sandbox', () => {
    const result = resolveExecutionPolicy('readonly');
    expect(result.mode).toBe('sandbox');
    expect(result.sandboxReadOnly).toBe(true);
  });

  it('maps draft to a read-only sandbox with artifact write', () => {
    const result = resolveExecutionPolicy('draft');
    expect(result.mode).toBe('sandbox');
    expect(result.sandboxReadOnly).toBe(true);
    expect(result.canWriteArtifacts).toBe(true);
  });

  it('maps readonly to no artifact write', () => {
    const result = resolveExecutionPolicy('readonly');
    expect(result.canWriteArtifacts).toBe(false);
  });

  it('maps readwrite to a read-write sandbox', () => {
    const result = resolveExecutionPolicy('readwrite');
    expect(result.mode).toBe('sandbox');
    expect(result.sandboxReadOnly).toBe(false);
    expect(result.canWriteArtifacts).toBe(true);
  });

  it('maps trusted to host access', () => {
    const result = resolveExecutionPolicy('trusted');
    expect(result.mode).toBe('host');
    expect(result.sandboxReadOnly).toBe(false);
  });

  it('fails closed on an unknown profile', () => {
    const result = resolveExecutionPolicy('root' as any);
    expect(result.mode).toBe('disabled');
    expect(result.reason).toContain('unknown profile');
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

  it('returns null for db_only mode without sandbox availability', () => {
    expect(validateSandboxAvailability('db_only', true)).toBeNull();
    expect(validateSandboxAvailability('db_only', false)).toBeNull();
  });

  it('returns null for disabled mode', () => {
    expect(validateSandboxAvailability('disabled', false)).toBeNull();
  });
});
