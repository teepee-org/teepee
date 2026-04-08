import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn as nodeSpawn } from 'child_process';
import { Orchestrator, type OrchestratorCallbacks } from './orchestrator.js';
import { openDb, createTopic, insertMessage, createUser, activateUser, setPermission } from './db.js';
import { runMigrations } from './db/migrate.js';
import type { TeepeeConfig } from './config.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';

function makeConfig(overrides?: Partial<TeepeeConfig>): TeepeeConfig {
  return {
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 } },
    server: { trust_proxy: false, cors_allowed_origins: [], auth_rate_limit_window_seconds: 60, auth_rate_limit_max_requests: 100 },
    providers: { echo: { command: 'echo hello' } },
    agents: {
      coder: { provider: 'echo', capability: 'host_allowed' },
      reviewer: { provider: 'echo', capability: 'sandbox_only' },
      disabled_agent: { provider: 'echo', capability: 'disabled' },
    },
    limits: { max_agents_per_message: 5, max_jobs_per_user_per_minute: 100, max_chain_depth: 2, max_total_jobs_per_chain: 10 },
    security: {
      role_defaults: { owner: 'host', user: 'sandbox', observer: 'disabled' },
      sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
    },
    ...overrides,
  };
}

function makeCallbacks(): OrchestratorCallbacks & { calls: Record<string, any[][]> } {
  const calls: Record<string, any[][]> = {
    onJobStarted: [],
    onJobStream: [],
    onJobCompleted: [],
    onJobFailed: [],
    onSystemMessage: [],
  };
  return {
    calls,
    onJobStarted: (...args: any[]) => { calls.onJobStarted.push(args); },
    onJobStream: (...args: any[]) => { calls.onJobStream.push(args); },
    onJobCompleted: (...args: any[]) => { calls.onJobCompleted.push(args); },
    onJobFailed: (...args: any[]) => { calls.onJobFailed.push(args); },
    onSystemMessage: (...args: any[]) => { calls.onSystemMessage.push(args); },
  };
}

function setupDb(): { db: DatabaseType; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-orch-test-'));
  const dbPath = path.join(tmpDir, 'db.sqlite');
  const db = openDb(dbPath);
  runMigrations(db);
  return { db, tmpDir };
}

function setupUsers(db: DatabaseType) {
  createUser(db, 'owner@test.com', 'owner');
  activateUser(db, 'owner@test.com', 'owner');
  createUser(db, 'user@test.com', 'user');
  activateUser(db, 'user@test.com', 'normaluser');
  createUser(db, 'observer@test.com', 'observer');
  activateUser(db, 'observer@test.com', 'watcher');
}

function makeHostLikeSandboxRunner(): SandboxRunner {
  return {
    name: 'bubblewrap',
    isAvailable: () => true,
    spawn(command: string, args: string[], options: SandboxOptions) {
      return nodeSpawn(command, args, {
        cwd: options.projectRoot,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  };
}

function makeContainerStubRunner(): SandboxRunner {
  return {
    name: 'container',
    isAvailable: () => true,
    spawn() {
      throw new Error('container runner should not spawn when provider sandbox config is missing');
    },
  };
}

describe('Orchestrator security', () => {
  let db: DatabaseType;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
    setupUsers(db);
  });

  it('disabled agent fails with audit metadata', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@disabled_agent do something');

    expect(callbacks.calls.onJobFailed.length).toBe(1);
    const [, , , error] = callbacks.calls.onJobFailed[0];
    expect(error).toContain('disabled');

    // Verify audit metadata persisted on the job
    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.requested_by_email).toBe('owner@test.com');
    expect(job.effective_mode).toBe('disabled');
  });

  it('observer is denied at permission level', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'observer@test.com', 'watcher', '@coder do something');

    // Observer is blocked by permission check (canTag returns false for observers)
    // so no job is created at all — a system denied message is emitted instead
    expect(callbacks.calls.onJobFailed.length).toBe(0);
    expect(callbacks.calls.onSystemMessage.length).toBeGreaterThan(0);
    const [, text] = callbacks.calls.onSystemMessage[0];
    expect(text).toContain('Permission denied');
  });

  it('sandbox_only agent stays sandboxed for owner', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    // This will try to run sandbox mode. Since bwrap may or may not be available,
    // check that the resolved mode is sandbox either way
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@reviewer review this');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    // The job should have effective_mode = sandbox (whether it succeeded or failed due to sandbox unavailability)
    expect(job.effective_mode).toBe('sandbox');
  });

  it('owner + host_allowed agent runs in host mode', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('host');
    expect(job.requested_by_email).toBe('owner@test.com');
  });

  it('user + host_allowed agent resolves to sandbox mode', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    // Grant user permission to tag coder
    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job).toBeTruthy();
    expect(job.effective_mode).toBe('sandbox');
    expect(job.requested_by_email).toBe('user@test.com');
  });

  it('disabled agent produces no onJobStarted callback (no spawn)', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@disabled_agent test');

    // Should have failed but never started
    expect(callbacks.calls.onJobStarted.length).toBe(0);
    expect(callbacks.calls.onJobFailed.length).toBe(1);
  });

  it('sandbox-required + backend unavailable fails closed with audit metadata', async () => {
    // Force sandbox config to 'container' which won't be available in test env
    const config = makeConfig({
      security: {
        role_defaults: { owner: 'host', user: 'sandbox', observer: 'disabled' },
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job).toBeTruthy();
    expect(job.status).toBe('failed');
    expect(job.effective_mode).toBe('sandbox');
    expect(job.requested_by_email).toBe('user@test.com');
    expect(job.error).toContain('Sandbox required but not available');

    // No spawn should have occurred
    expect(callbacks.calls.onJobStarted.length).toBe(0);
    expect(callbacks.calls.onJobFailed.length).toBe(1);
  });

  it('container backend fails closed when provider sandbox runtime is missing', async () => {
    const config = makeConfig({
      security: {
        role_defaults: { owner: 'host', user: 'sandbox', observer: 'disabled' },
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeContainerStubRunner();
    (orch as any).sandboxBackend = 'container';

    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.effective_mode).toBe('sandbox');
    expect(job.requested_by_email).toBe('user@test.com');
    expect(job.error).toContain("requires provider 'echo' to define providers.echo.sandbox.image");
    expect(callbacks.calls.onJobStarted.length).toBe(0);
    expect(callbacks.calls.onJobFailed.length).toBe(1);
  });

  it('insecure mode promotes user sandbox_only agent to host', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks, { insecure: true });

    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@reviewer review this');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('host');
    expect(job.requested_by_email).toBe('user@test.com');
  });

  it('insecure mode still keeps disabled agents disabled', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks, { insecure: true });

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@disabled_agent do something');

    expect(callbacks.calls.onJobFailed.length).toBe(1);
    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('disabled');
  });

  it('insecure mode allows user + host_allowed to run as host', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks, { insecure: true });
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('host');
  });

  it('secure mode still fails closed when sandbox required but unavailable', async () => {
    const config = makeConfig({
      security: {
        role_defaults: { owner: 'host', user: 'sandbox', observer: 'disabled' },
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    // Explicitly NOT insecure
    const orch = new Orchestrator(db, config, tmpDir, callbacks, { insecure: false });
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.effective_mode).toBe('sandbox');
    expect(job.error).toContain('Sandbox required but not available');
  });

  it('chained jobs inherit the original requester sandbox policy', async () => {
    const coderScript = path.join(tmpDir, 'coder.js');
    const chainedScript = path.join(tmpDir, 'chain-target.js');

    fs.writeFileSync(coderScript, "console.log('@chain_target please continue');\n");
    fs.writeFileSync(chainedScript, "console.log('done');\n");

    const config = makeConfig({
      providers: {
        coder_provider: { command: 'node coder.js' },
        chain_provider: { command: 'node chain-target.js' },
      },
      agents: {
        coder: { provider: 'coder_provider', capability: 'host_allowed' },
        chain_target: { provider: 'chain_provider', capability: 'host_allowed' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    setPermission(db, 'user@test.com', null, '*', true);

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder start');

    const jobs = db.prepare('SELECT agent_name, effective_mode, requested_by_email FROM jobs ORDER BY id').all() as any[];
    expect(jobs).toEqual([
      { agent_name: 'coder', effective_mode: 'sandbox', requested_by_email: 'user@test.com' },
      { agent_name: 'chain_target', effective_mode: 'sandbox', requested_by_email: 'user@test.com' },
    ]);
    expect(callbacks.calls.onJobCompleted.length).toBe(2);
  });
});
