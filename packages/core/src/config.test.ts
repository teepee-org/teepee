import { describe, it, expect } from 'vitest';
import { loadConfig, resolvePrompt, resolveTimeout } from './config.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-test-'));
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const file = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(file, content);
  return file;
}

describe('loadConfig', () => {
  it('loads valid config', () => {
    const file = tmpConfig(`
teepee:
  name: test-project
  language: it

providers:
  claude:
    command: "echo test"
    timeout_seconds: 60

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
    prompt: "./prompts/reviewer.md"
`);
    const config = loadConfig(file);
    expect(config.version).toBe(1);
    expect(config.mode).toBe('private');
    expect(config.teepee.name).toBe('test-project');
    expect(config.teepee.language).toBe('it');
    expect(config.teepee.demo.enabled).toBe(false);
    expect(config.providers.claude.command).toBe('echo test');
    expect(config.providers.claude.timeout_seconds).toBe(60);
    expect(config.agents.coder.provider).toBe('claude');
    expect(config.agents.reviewer.prompt).toBe('./prompts/reviewer.md');
  });

  it('loads explicit shared mode', () => {
    const file = tmpConfig(`
version: 1
mode: shared
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.version).toBe(1);
    expect(config.mode).toBe('shared');
  });

  it('rejects invalid mode', () => {
    const file = tmpConfig(`
mode: public
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("mode must be 'private' or 'shared'");
  });

  it('rejects default_role', () => {
    const file = tmpConfig(`
default_role: observer
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow('default_role is not supported');
  });

  it('applies default language', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.teepee.language).toBe('en');
  });

  it('applies default limits', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.limits.max_agents_per_message).toBe(5);
    expect(config.limits.max_chain_depth).toBe(2);
    expect(config.server.trust_proxy).toBe(false);
    expect(config.server.cors_allowed_origins).toEqual([]);
    expect(config.server.auth_rate_limit_window_seconds).toBe(60);
    expect(config.server.auth_rate_limit_max_requests).toBe(20);
    expect(config.teepee.demo).toEqual({
      enabled: false,
      topic_name: 'hn-live-demo',
      hotkey: 'F1',
      delay_ms: 1200,
    });
  });

  it('loads optional server settings', () => {
    const file = tmpConfig(`
teepee:
  name: test
server:
  trust_proxy: true
  cors_allowed_origins:
    - "https://app.example.com"
  auth_rate_limit_window_seconds: 120
  auth_rate_limit_max_requests: 7
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.server.trust_proxy).toBe(true);
    expect(config.server.cors_allowed_origins).toEqual(['https://app.example.com']);
    expect(config.server.auth_rate_limit_window_seconds).toBe(120);
    expect(config.server.auth_rate_limit_max_requests).toBe(7);
  });

  it('accepts a single cors origin string', () => {
    const file = tmpConfig(`
teepee:
  name: test
server:
  cors_allowed_origins: "https://app.example.com"
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.server.cors_allowed_origins).toEqual(['https://app.example.com']);
  });

  it('loads optional demo settings', () => {
    const file = tmpConfig(`
teepee:
  name: test
  demo:
    enabled: true
    topic_name: autoplay-demo
    hotkey: F2
    delay_ms: 1800
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.teepee.demo).toEqual({
      enabled: true,
      topic_name: 'autoplay-demo',
      hotkey: 'F2',
      delay_ms: 1800,
    });
  });

  it('rejects missing name', () => {
    const file = tmpConfig(`
teepee: {}
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow('teepee.name is required');
  });

  it('rejects unknown provider reference', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  claude:
    command: "echo"
agents:
  coder:
    provider: codex
`);
    expect(() => loadConfig(file)).toThrow("unknown provider 'codex'");
  });

  it('rejects missing command', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p: {}
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("missing 'command'");
  });

  it('rejects no providers', () => {
    const file = tmpConfig(`
teepee:
  name: test
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow('at least one provider');
  });

  it('rejects no agents', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
`);
    expect(() => loadConfig(file)).toThrow('at least one agent');
  });

  it('rejects legacy security.role_defaults', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  role_defaults:
    user: sandbx
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("unknown security key 'role_defaults'");
  });

  it('rejects invalid agent capability', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
    capability: full_access
`);
    expect(() => loadConfig(file)).toThrow("invalid capability 'full_access'");
  });

  it('rejects invalid sandbox runner', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  sandbox:
    runner: firejail
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("security.sandbox.runner must be one of");
  });

  it('accepts container as sandbox runner', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  sandbox:
    runner: container
    container_image: "teepee/runner:latest"
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.security.sandbox.runner).toBe('container');
    expect(config.security.sandbox.container_image).toBe('teepee/runner:latest');
  });

  it('loads provider sandbox config', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  claude:
    command: "claude -p"
    sandbox:
      image: "teepee/claude-runner:latest"
      command: "claude -p --permission-mode acceptEdits"
agents:
  a:
    provider: claude
`);
    const config = loadConfig(file);
    expect(config.providers.claude.sandbox).toEqual({
      image: 'teepee/claude-runner:latest',
      command: 'claude -p --permission-mode acceptEdits',
    });
  });

  it('rejects provider sandbox config without image', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  claude:
    command: "claude -p"
    sandbox:
      command: "claude -p"
agents:
  a:
    provider: claude
`);
    expect(() => loadConfig(file)).toThrow("sandbox requires a valid 'image'");
  });

  it('rejects provider sandbox config with non-string command', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  claude:
    command: "claude -p"
    sandbox:
      image: "teepee/claude-runner:latest"
      command:
        - claude
        - -p
agents:
  a:
    provider: claude
`);
    expect(() => loadConfig(file)).toThrow("sandbox.command must be a string");
  });

  it('rejects legacy role_defaults instead of configurable execution modes', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  role_defaults:
    owner: db_only
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("unknown security key 'role_defaults'");
  });

  it('rejects unknown security key', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  custom_key: true
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("unknown security key 'custom_key'");
  });

  it('rejects role_defaults as a legacy security key', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  role_defaults:
    owner: host
    superadmin: host
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("unknown security key 'role_defaults'");
  });

  it('rejects unknown security.sandbox key', () => {
    const file = tmpConfig(`
teepee:
  name: test
security:
  sandbox:
    runner: bubblewrap
    network_isolation: true
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("unknown security.sandbox key 'network_isolation'");
  });

  it('rejects invalid agent chain_policy', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
    chain_policy: auto_chain
`);
    expect(() => loadConfig(file)).toThrow("invalid chain_policy 'auto_chain'");
  });

  it('loads top-level role-agent matrix', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
  b:
    provider: p
roles:
  owner:
    a: trusted
    b: readwrite
  collaborator:
    a: readwrite
  observer:
    b: readonly
`);
    const config = loadConfig(file);
    expect(config.roles.owner.agents).toEqual({ a: 'trusted', b: 'readwrite' });
    expect(config.roles.collaborator.agents).toEqual({ a: 'readwrite' });
    expect(config.roles.observer.agents).toEqual({ b: 'readonly' });
  });

  it('accepts draft as a valid access profile', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
roles:
  owner:
    a: trusted
  collaborator:
    a: draft
`);
    const config = loadConfig(file);
    expect(config.roles.collaborator.agents).toEqual({ a: 'draft' });
  });

  it('rejects custom role without required capabilities', () => {
    const file = tmpConfig(`
version: 2
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
roles:
  owner:
    superuser: true
    agents:
      a: trusted
  qa:
    agents:
      a: readwrite
`);
    expect(() => loadConfig(file)).toThrow('roles.qa.capabilities is required');
  });

  it('rejects unknown role profiles', () => {
    const file = tmpConfig(`
version: 2
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
roles:
  owner:
    superuser: true
    agents:
      a: root
`);
    expect(() => loadConfig(file)).toThrow('must be one of: readonly, draft, readwrite, trusted');
  });

  it('rejects legacy agent profile when roles are present', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
    profile: trusted
roles:
  owner:
    a: trusted
`);
    expect(() => loadConfig(file)).toThrow("uses legacy 'profile'");
  });

  it('rejects custom top-level profiles', () => {
    const file = tmpConfig(`
teepee:
  name: test
profiles:
  semi_trusted:
    fs: read
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    expect(() => loadConfig(file)).toThrow("custom 'profiles' are not supported");
  });

  it('loads valid chain_policy', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
    chain_policy: delegate_with_origin_policy
`);
    const config = loadConfig(file);
    expect(config.agents.a.chain_policy).toBe('delegate_with_origin_policy');
  });

  it('defaults architect chain_policy to delegate_with_origin_policy', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  architect:
    provider: p
  coder:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.agents.architect.chain_policy).toBe('delegate_with_origin_policy');
    expect(config.agents.coder.chain_policy).toBe('delegate_with_origin_policy');
  });

  it('applies default security config when not specified', () => {
    const file = tmpConfig(`
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  a:
    provider: p
`);
    const config = loadConfig(file);
    expect(config.security.sandbox.runner).toBe('bubblewrap');
    expect(config.security.sandbox.empty_home).toBe(true);
    expect(config.security.sandbox.private_tmp).toBe(true);
    expect(config.security.sandbox.forward_env).toEqual([]);
  });
});

describe('resolveTimeout', () => {
  const config = {
    version: 1 as const,
    mode: 'private' as const,
    teepee: {
      name: 'test',
      language: 'en',
      demo: {
        enabled: false,
        topic_name: 'hn-live-demo',
        hotkey: 'F1',
        delay_ms: 1200,
      },
    },
    providers: {
      claude: { command: 'echo', timeout_seconds: 90 },
      fast: { command: 'echo' },
    },
    agents: {
      coder: { provider: 'claude', timeout_seconds: 180 },
      reviewer: { provider: 'claude' },
      quick: { provider: 'fast' },
    },
    roles: {
      owner: { coder: 'trusted' as const, reviewer: 'readwrite' as const, quick: 'readwrite' as const },
      collaborator: { coder: 'readwrite' as const, reviewer: 'readwrite' as const, quick: 'readwrite' as const },
      observer: {},
    },
    limits: {
      max_agents_per_message: 5,
      max_jobs_per_user_per_minute: 10,
      max_chain_depth: 2,
      max_total_jobs_per_chain: 10,
    },
    server: {
      trust_proxy: false,
      cors_allowed_origins: [],
      auth_rate_limit_window_seconds: 60,
      auth_rate_limit_max_requests: 20,
    },
    security: {
      sandbox: { runner: 'bubblewrap' as const, empty_home: true, private_tmp: true, forward_env: [] },
    },
  };

  it('uses agent timeout if set', () => {
    expect(resolveTimeout('coder', config)).toBe(180_000);
  });

  it('falls back to provider timeout', () => {
    expect(resolveTimeout('reviewer', config)).toBe(90_000);
  });

  it('falls back to default 180s when neither agent nor provider sets timeout_seconds', () => {
    expect(resolveTimeout('quick', config)).toBe(180_000);
  });
});
