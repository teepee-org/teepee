import { describe, expect, it } from 'vitest';
import { buildSandboxAuthMountPlan, buildSandboxCommandMountPlan, checkSandboxCommandAvailability } from './command.js';

describe('checkSandboxCommandAvailability', () => {
  it('accepts executables in the sandbox path', () => {
    const result = checkSandboxCommandAvailability('codex exec', '/usr/local/bin:/usr/bin:/bin');
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe('/usr/local/bin/codex');
  });

  it('rejects absolute paths outside sandbox-visible directories', () => {
    const result = checkSandboxCommandAvailability('/home/test/.npm/bin/codex exec');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside the Linux sandbox-visible directories');
  });

  it('builds a mount plan for host-only executables', () => {
    const plan = buildSandboxCommandMountPlan('claude -p', () => '/home/test/.local/bin/claude');
    expect(plan).not.toBeNull();
    expect(plan!.readOnlyPaths).toEqual(['/home/test/.local']);
    expect(plan!.pathEntries).toEqual(['/home/test/.local/bin']);
  });

  it('builds auth mounts for codex and claude homes', () => {
    const exists = (target: string) => [
      '/home/test/.codex',
      '/home/test/.claude',
      '/home/test/.claude.json',
      '/home/test/.cache/claude',
    ].includes(target);

    expect(buildSandboxAuthMountPlan('codex exec', '/home/test', '/home/agent', exists)).toEqual([
      { source: '/home/test/.codex', target: '/home/agent/.codex' },
    ]);

    expect(buildSandboxAuthMountPlan('claude -p', '/home/test', '/home/agent', exists)).toEqual([
      { source: '/home/test/.claude', target: '/home/agent/.claude' },
      { source: '/home/test/.claude.json', target: '/home/agent/.claude.json' },
      { source: '/home/test/.cache/claude', target: '/home/agent/.cache/claude' },
    ]);
  });
});
