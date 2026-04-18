import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn as nodeSpawn } from 'child_process';
import { Orchestrator, type OrchestratorCallbacks } from './orchestrator.js';
import {
  openDb,
  createTopic,
  insertMessage,
  createUser,
  activateUser,
  createDocumentArtifact,
  updateDocumentArtifact,
  getArtifactVersions,
} from './db.js';
import { runMigrations } from './db/migrate.js';
import type { TeepeeConfig } from './config.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';

function makeConfig(overrides?: Partial<TeepeeConfig> & { agents?: Record<string, any>; security?: any }): TeepeeConfig {
  const agents: Record<string, any> = overrides?.agents ?? {
    coder: { provider: 'echo', capability: 'host_allowed' },
    reviewer: { provider: 'echo', capability: 'sandbox_only' },
    disabled_agent: { provider: 'echo', capability: 'disabled' },
  };
  const roles = overrides?.roles ?? legacyRolesForTest(agents);
  const base: TeepeeConfig = {
    version: 1,
    mode: 'private',
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 } },
    server: { trust_proxy: false, cors_allowed_origins: [], auth_rate_limit_window_seconds: 60, auth_rate_limit_max_requests: 100 },
    providers: { echo: { command: 'echo hello' } },
    agents,
    roles,
    filesystem: {
      roots: [{ id: 'workspace', kind: 'workspace', path: '.', resolvedPath: process.cwd() }],
    },
    limits: { max_agents_per_message: 5, max_jobs_per_user_per_minute: 100, max_chain_depth: 2, max_total_jobs_per_chain: 10 },
    security: {
      sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
    },
  };
  return {
    ...base,
    ...overrides,
    agents,
    roles,
    security: overrides?.security ?? {
      sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
    },
  };
}

function legacyRolesForTest(agents: Record<string, any>): TeepeeConfig['roles'] {
  const roles: TeepeeConfig['roles'] = {
    owner: { superuser: true, agents: {} },
    collaborator: { capabilities: ['files.workspace.access', 'messages.post'], agents: {} },
    observer: { capabilities: ['files.workspace.access'], agents: {} },
  };
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.capability === 'disabled') continue;
    if (agent.profile === 'trusted') {
      roles.owner.agents[name] = 'trusted';
      continue;
    }
    if (agent.profile === 'restricted') {
      roles.owner.agents[name] = 'readonly';
      roles.collaborator.agents[name] = 'readonly';
      continue;
    }
    roles.owner.agents[name] = 'readwrite';
    roles.collaborator.agents[name] = 'readwrite';
  }
  return roles;
}

function makeCallbacks(): OrchestratorCallbacks & { calls: Record<string, any[][]> } {
  const calls: Record<string, any[][]> = {
    onJobStarted: [],
    onJobStream: [],
    onJobRetrying: [],
    onJobRoundStarted: [],
    onJobWaitingInput: [],
    onJobResumed: [],
    onJobCompleted: [],
    onJobFailed: [],
    onSystemMessage: [],
    onRuntimeChanged: [],
  };
  return {
    calls,
    onJobStarted: (...args: any[]) => { calls.onJobStarted.push(args); },
    onJobStream: (...args: any[]) => { calls.onJobStream.push(args); },
    onJobRetrying: (...args: any[]) => { calls.onJobRetrying.push(args); },
    onJobRoundStarted: (...args: any[]) => { calls.onJobRoundStarted.push(args); },
    onJobWaitingInput: (...args: any[]) => { calls.onJobWaitingInput.push(args); },
    onJobResumed: (...args: any[]) => { calls.onJobResumed.push(args); },
    onJobCompleted: (...args: any[]) => { calls.onJobCompleted.push(args); },
    onJobFailed: (...args: any[]) => { calls.onJobFailed.push(args); },
    onSystemMessage: (...args: any[]) => { calls.onSystemMessage.push(args); },
    onRuntimeChanged: (...args: any[]) => { calls.onRuntimeChanged.push(args); },
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
  createUser(db, 'user@test.com', 'collaborator');
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number = 3000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it('unmapped agent is denied before job creation', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@disabled_agent do something');

    expect(callbacks.calls.onJobFailed.length).toBe(0);
    expect(callbacks.calls.onSystemMessage.length).toBe(1);
    const [, , text] = callbacks.calls.onSystemMessage[0];
    expect(text).toContain('Permission denied');
    const jobs = db.prepare('SELECT * FROM jobs').all() as any[];
    expect(jobs.length).toBe(0);
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
    const [, , text] = callbacks.calls.onSystemMessage[0];
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

  it('owner + normal host_allowed agent resolves to sandbox mode', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('sandbox');
    expect(job.requested_by_email).toBe('owner@test.com');
  });

  it('owner + trusted host_allowed agent runs in host mode', async () => {
    const config = makeConfig({
      agents: {
        coder: { provider: 'echo', capability: 'host_allowed', profile: 'trusted' },
        reviewer: { provider: 'echo', capability: 'sandbox_only' },
        disabled_agent: { provider: 'echo', capability: 'disabled' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('host');
    expect(job.requested_by_email).toBe('owner@test.com');
  });

  it('collaborator + host_allowed agent resolves to sandbox mode', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job).toBeTruthy();
    expect(job.effective_mode).toBe('sandbox');
    expect(job.requested_by_email).toBe('user@test.com');
  });

  it('unmapped agent produces no onJobStarted callback or spawn', async () => {
    const config = makeConfig();
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@disabled_agent test');

    expect(callbacks.calls.onJobStarted.length).toBe(0);
    expect(callbacks.calls.onJobFailed.length).toBe(0);
    expect(callbacks.calls.onSystemMessage.length).toBe(1);
  });

  it('sandbox-required + backend unavailable fails closed with audit metadata', async () => {
    // Force sandbox config to 'container' which won't be available in test env
    const config = makeConfig({
      security: {
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

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
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

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

  it('architect respects explicit trusted profile and can run as host for owner', async () => {
    const config = makeConfig({
      agents: {
        architect: { provider: 'echo', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@architect review');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('host');
  });

  it('architect with normal profile stays in sandbox', async () => {
    const config = makeConfig({
      agents: {
        architect: { provider: 'echo', capability: 'host_allowed', profile: 'normal' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@architect review');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('sandbox');
  });

  it('legacy restricted agent resolves to readonly sandbox for collaborator', async () => {
    const config = makeConfig({
      agents: {
        helper: { provider: 'echo', capability: 'host_allowed', profile: 'restricted' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@helper help');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('sandbox');
    expect(job.effective_profile).toBe('readonly');
  });

  it('fails closed when sandbox is required but unavailable', async () => {
    const config = makeConfig({
      security: {
        sandbox: { runner: 'container', empty_home: true, private_tmp: true, forward_env: [] },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder hello');

    const job = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.effective_mode).toBe('sandbox');
    expect(job.error).toContain('Sandbox required but not available');
  });

  it('chained jobs inherit the original requester sandbox policy', async () => {
    const coderScript = path.join(tmpDir, 'coder.js');
    const chainedScript = path.join(tmpDir, 'chain-target.js');

    fs.writeFileSync(coderScript, "setTimeout(() => console.log('@chain_target please continue'), 25);\n");
    fs.writeFileSync(chainedScript, "setTimeout(() => console.log('done'), 25);\n");

    const config = makeConfig({
      providers: {
        coder_provider: { command: 'node coder.js' },
        chain_provider: { command: 'node chain-target.js' },
      },
      agents: {
        coder: { provider: 'coder_provider', capability: 'host_allowed', chain_policy: 'delegate_with_origin_policy' },
        chain_target: { provider: 'chain_provider', capability: 'host_allowed' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

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

  it('agent with chain_policy=none does not trigger chained agents', async () => {
    const coderScript = path.join(tmpDir, 'coder-no-chain.js');
    fs.writeFileSync(coderScript, "setTimeout(() => console.log('@chain_target please continue'), 25);\n");

    const config = makeConfig({
      providers: {
        coder_provider: { command: 'node coder-no-chain.js' },
        chain_provider: { command: 'echo done' },
      },
      agents: {
        coder: { provider: 'coder_provider', capability: 'host_allowed', chain_policy: 'none' },
        chain_target: { provider: 'chain_provider', capability: 'host_allowed' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder start');

    const jobs = db.prepare('SELECT agent_name FROM jobs ORDER BY id').all() as any[];
    expect(jobs).toEqual([{ agent_name: 'coder' }]);
    expect(callbacks.calls.onJobCompleted.length).toBe(1);
  });

  it('architect chain delegation to trusted coder works for owner', async () => {
    const config = makeConfig({
      providers: {
        arch_echo: { command: 'echo @coder do this' },
        coder_echo: { command: 'echo done' },
      },
      agents: {
        architect: { provider: 'arch_echo', capability: 'host_allowed', profile: 'restricted', chain_policy: 'delegate_with_origin_policy' },
        coder: { provider: 'coder_echo', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@architect plan');

    const jobs = db.prepare('SELECT agent_name, effective_mode FROM jobs ORDER BY id').all() as any[];
    expect(jobs.length).toBe(2);
    expect(jobs[0]).toEqual({ agent_name: 'architect', effective_mode: 'sandbox' });
    expect(jobs[1]).toEqual({ agent_name: 'coder', effective_mode: 'host' });
  });

  it('architect chain delegation to trusted coder denied for collaborator', async () => {
    const config = makeConfig({
      providers: {
        arch_echo: { command: 'echo @coder do this' },
        coder_echo: { command: 'echo done' },
      },
      agents: {
        architect: { provider: 'arch_echo', capability: 'host_allowed', profile: 'restricted', chain_policy: 'delegate_with_origin_policy' },
        coder: { provider: 'coder_echo', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@architect plan');

    // architect is readonly for collaborator, but architect output @coder.
    // coder is trusted for owner only in this legacy test mapping, so collaborator is denied.
    const jobs = db.prepare('SELECT agent_name, effective_mode FROM jobs ORDER BY id').all() as any[];

    // Only architect job should exist; coder should be denied at chain permission level
    const architectJob = jobs.find((j: any) => j.agent_name === 'architect');
    expect(architectJob).toBeTruthy();
    expect(architectJob.effective_mode).toBe('sandbox');

    // coder should NOT have a job (denied by chain permission filtering)
    const coderJob = jobs.find((j: any) => j.agent_name === 'coder');
    expect(coderJob).toBeUndefined();

    // System message about chain denial
    expect(callbacks.calls.onSystemMessage.length).toBeGreaterThan(0);
    const sysMsgs = callbacks.calls.onSystemMessage.map((c: any) => c[2]);
    expect(sysMsgs.some((m: string) => m.includes('Chain delegation denied'))).toBe(true);
  });

  it('readonly agent uses the sandbox runner with read-only project access', async () => {
    const config = makeConfig({
      providers: {
        internal: { command: 'echo done' },
      },
      agents: {
        helper: { provider: 'internal', capability: 'host_allowed', profile: 'restricted' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const spawnCalls: any[] = [];
    const mockRunner: SandboxRunner = {
      name: 'bubblewrap',
      isAvailable: () => true,
      spawn(command: string, args: string[], options: SandboxOptions) {
        spawnCalls.push({ command, args, options });
        return nodeSpawn(command, args, {
          cwd: options.projectRoot,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    };

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = mockRunner;
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@helper help');

    const job = db.prepare('SELECT effective_mode, effective_profile FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('sandbox');
    expect(job.effective_profile).toBe('readonly');

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].options.readOnlyProject).toBe(true);
    expect(callbacks.calls.onJobCompleted.length).toBe(1);
  });

  it('readonly agent can execute provider CLI inside the read-only sandbox', async () => {
    const config = makeConfig({
      agents: {
        helper: { provider: 'echo', capability: 'host_allowed', profile: 'restricted' },
      },
    });
    const callbacks = makeCallbacks();
    const topicId = createTopic(db, 'test');

    const spawnCalls: any[] = [];
    const mockRunner: SandboxRunner = {
      name: 'bubblewrap',
      isAvailable: () => true,
      spawn(command: string, args: string[], options: SandboxOptions) {
        spawnCalls.push({ command, args, options });
        return nodeSpawn(command, args, {
          cwd: options.projectRoot,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    };

    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = mockRunner;
    (orch as any).sandboxBackend = 'bubblewrap';

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@helper help');

    const job = db.prepare('SELECT effective_mode, effective_profile, status, error FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.effective_mode).toBe('sandbox');
    expect(job.effective_profile).toBe('readonly');
    expect(job.status).toBe('done');
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].options.readOnlyProject).toBe(true);
  });

  it('forces readonly profile for all jobs tagged in the same message', async () => {
    const config = makeConfig({
      roles: {
        owner: { superuser: true, agents: { coder: 'trusted', reviewer: 'readwrite' } },
        collaborator: { capabilities: ['files.workspace.access', 'messages.post'], agents: { coder: 'readwrite', reviewer: 'readwrite' } },
        observer: { capabilities: ['files.workspace.access'], agents: {} },
      } as any,
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder @reviewer analyze this');
    await waitForCondition(() => callbacks.calls.onJobCompleted.length === 2);

    const jobs = db.prepare('SELECT agent_name, effective_profile, effective_mode FROM jobs ORDER BY id').all() as any[];
    expect(jobs).toEqual([
      { agent_name: 'coder', effective_profile: 'readonly', effective_mode: 'sandbox' },
      { agent_name: 'reviewer', effective_profile: 'readonly', effective_mode: 'sandbox' },
    ]);
  });

  it('blocks readonly work queued behind a writer barrier', async () => {
    const eventLogPath = path.join(tmpDir, 'barrier-order.log');
    fs.writeFileSync(
      path.join(tmpDir, 'reader-a.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'reader_a:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'reader_a:end\\n');",
        "  console.log('reader a done');",
        "}, 80);",
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'writer.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'writer:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'writer:end\\n');",
        "  console.log('writer done');",
        "}, 40);",
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'reader-b.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'reader_b:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'reader_b:end\\n');",
        "  console.log('reader b done');",
        "}, 20);",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        reader_a_provider: { command: 'node reader-a.js' },
        writer_provider: { command: 'node writer.js' },
        reader_b_provider: { command: 'node reader-b.js' },
      },
      agents: {
        reader_a: { provider: 'reader_a_provider' },
        writer: { provider: 'writer_provider' },
        reader_b: { provider: 'reader_b_provider' },
      },
      roles: {
        owner: { superuser: true, agents: { reader_a: 'readonly', writer: 'readwrite', reader_b: 'readonly' } },
        collaborator: { capabilities: ['files.workspace.access', 'messages.post'], agents: { reader_a: 'readonly', writer: 'readwrite', reader_b: 'readonly' } },
        observer: { capabilities: ['files.workspace.access'], agents: {} },
      } as any,
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    const topicId = createTopic(db, 'test');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@reader_a inspect');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@writer change');
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@reader_b inspect');
    await waitForCondition(() => callbacks.calls.onJobCompleted.length === 3, 5000);

    const logLines = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n');
    expect(logLines.indexOf('reader_a:end')).toBeLessThan(logLines.indexOf('writer:start'));
    expect(logLines.indexOf('writer:end')).toBeLessThan(logLines.indexOf('reader_b:start'));
  });

  it('prioritizes child jobs in the active chain ahead of external queued writers', async () => {
    const eventLogPath = path.join(tmpDir, 'chain-order.log');
    fs.writeFileSync(
      path.join(tmpDir, 'architect-chain.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'architect:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'architect:end\\n');",
        "  console.log('@coder implement it');",
        "}, 40);",
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'coder-chain.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'coder:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'coder:end\\n');",
        "  console.log('coder done');",
        "}, 40);",
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'writer-external.js'),
      [
        "const fs = require('fs');",
        `const log = ${JSON.stringify(eventLogPath)};`,
        "fs.appendFileSync(log, 'external_writer:start\\n');",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, 'external_writer:end\\n');",
        "  console.log('external done');",
        "}, 30);",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        architect_provider: { command: 'node architect-chain.js' },
        coder_provider: { command: 'node coder-chain.js' },
        writer_provider: { command: 'node writer-external.js' },
      },
      agents: {
        architect: { provider: 'architect_provider', chain_policy: 'delegate_with_origin_policy' },
        coder: { provider: 'coder_provider' },
        writer: { provider: 'writer_provider' },
      },
      roles: {
        owner: { superuser: true, agents: { architect: 'readonly', coder: 'readwrite', writer: 'readwrite' } },
        collaborator: { capabilities: ['files.workspace.access', 'messages.post'], agents: { architect: 'readonly', coder: 'readwrite', writer: 'readwrite' } },
        observer: { capabilities: ['files.workspace.access'], agents: {} },
      } as any,
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    (orch as any).sandboxAvailable = true;
    (orch as any).sandboxRunner = makeHostLikeSandboxRunner();
    (orch as any).sandboxBackend = 'bubblewrap';

    const topicId = createTopic(db, 'test');
    const firstRun = orch.handleMessage(topicId, 'owner@test.com', 'owner', '@architect analyze');
    await waitForCondition(() => fs.existsSync(eventLogPath) && fs.readFileSync(eventLogPath, 'utf-8').includes('architect:start'));
    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@writer do external work');
    await firstRun;
    await waitForCondition(() => callbacks.calls.onJobCompleted.length === 3, 5000);

    const logLines = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n');
    expect(logLines.indexOf('architect:end')).toBeLessThan(logLines.indexOf('coder:start'));
    expect(logLines.indexOf('coder:end')).toBeLessThan(logLines.indexOf('external_writer:start'));
  });

  it('supports lazy artifact reads before updating the current head', async () => {
    const topicId = createTopic(db, 'test');
    const { artifact } = createDocumentArtifact(db, {
      topicId,
      kind: 'plan',
      title: 'Plan',
      body: '# v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: '# v2',
    });

    const agentScript = path.join(tmpDir, 'artifact-reader-agent.js');
    fs.writeFileSync(
      agentScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const input = fs.readFileSync(0, 'utf8');",
        "const out = process.env.TEEPEE_OUTPUT_DIR;",
        "if (!input.includes('[artifact-op-results]\\n{')) {",
        "  fs.writeFileSync(path.join(out, 'artifact-ops.json'), JSON.stringify({ operations: [",
        "    { op_id: 'r1', op: 'read-current', artifact_id: 1 },",
        "    { op_id: 'r2', op: 'read-version', artifact_id: 1, version: 1 },",
        "    { op_id: 'r3', op: 'read-diff', artifact_id: 1, from_version: 1, to_version: 'current', format: 'summary' }",
        "  ] }));",
        "  console.log('requesting artifact reads');",
        "} else {",
        "  const jsonText = input.split('[artifact-op-results]\\n')[1].split('\\n\\n[messages]')[0];",
        "  const parsed = JSON.parse(jsonText);",
        "  const current = parsed.results.find((r) => r.op === 'read-current');",
        "  const previous = parsed.results.find((r) => r.op === 'read-version');",
        "  fs.writeFileSync(path.join(out, 'files', 'plan.md'), `# v3\\n\\nBase: ${current.version}\\nCurrent: ${current.body}\\nPrevious: ${previous.body}\\n`);",
        "  fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "    { op: 'update', artifact_id: 1, base_version: 'current', path: 'files/plan.md' }",
        "  ] }));",
        "  fs.writeFileSync(path.join(out, 'response.md'), 'Artifact updated after lazy reads.');",
        "  console.log('done');",
        "}",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        artifact_provider: { command: 'node artifact-reader-agent.js' },
      },
      agents: {
        coder: { provider: 'artifact_provider', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder aggiorna il documento');

    const versions = getArtifactVersions(db, artifact.id);
    expect(versions).toHaveLength(3);
    expect(versions[2].body).toContain('Base: 2');
    expect(versions[2].body).toContain('Current: # v2');
    expect(versions[2].body).toContain('Previous: # v1');
    expect(callbacks.calls.onJobCompleted).toHaveLength(1);

    const summaryCalls = callbacks.calls.onSystemMessage.filter((c: any[]) =>
      typeof c[2] === 'string' && c[2].includes('📄 artifact')
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0][2]).toContain(`"Plan" → v3 (updated)`);

    const sysRows = db
      .prepare("SELECT body FROM messages WHERE topic_id = ? AND author_type = 'system'")
      .all(topicId) as Array<{ body: string }>;
    expect(sysRows.some((r) => r.body.includes('📄 artifact "Plan" → v3 (updated)'))).toBe(true);
  });

  it('supports rewrite-from-version after reading both head and source version', async () => {
    const topicId = createTopic(db, 'test');
    const { artifact } = createDocumentArtifact(db, {
      topicId,
      kind: 'report',
      title: 'Che cos\'e Teepee',
      body: '# v1\n\nIntro v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: '# v2\n\nIntro v2',
    });

    const agentScript = path.join(tmpDir, 'artifact-rewrite-agent.js');
    fs.writeFileSync(
      agentScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const input = fs.readFileSync(0, 'utf8');",
        "const out = process.env.TEEPEE_OUTPUT_DIR;",
        "if (!input.includes('[artifact-op-results]\\n{')) {",
        "  fs.writeFileSync(path.join(out, 'artifact-ops.json'), JSON.stringify({ operations: [",
        "    { op_id: 'r1', op: 'read-current', artifact_id: 1 },",
        "    { op_id: 'r2', op: 'read-version', artifact_id: 1, version: 1 }",
        "  ] }));",
        "  console.log('requesting artifact reads');",
        "} else {",
        "  const jsonText = input.split('[artifact-op-results]\\n')[1].split('\\n\\n[messages]')[0];",
        "  const parsed = JSON.parse(jsonText);",
        "  const current = parsed.results.find((r) => r.op === 'read-current');",
        "  const source = parsed.results.find((r) => r.op === 'read-version' && r.version === 1);",
        "  fs.writeFileSync(path.join(out, 'files', 'report.md'), `${source.body}\\n\\n## Sicurezza\\n\\nBase head: ${current.version}\\n`);",
        "  fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "    { op: 'rewrite-from-version', artifact_id: 1, base_version: 'current', source_version: source.version, path: 'files/report.md' }",
        "  ] }));",
        "  fs.writeFileSync(path.join(out, 'response.md'), 'Artifact rewritten from v1.');",
        "  console.log('done');",
        "}",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        artifact_provider: { command: 'node artifact-rewrite-agent.js' },
      },
      agents: {
        coder: { provider: 'artifact_provider', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder aggiungi un paragrafo sicurezza alla versione 1');

    const versions = getArtifactVersions(db, artifact.id);
    expect(versions).toHaveLength(3);
    expect(versions[2].body).toContain('Intro v1');
    expect(versions[2].body).not.toContain('Intro v2');
    expect(versions[2].body).toContain('## Sicurezza');
    expect(callbacks.calls.onJobCompleted).toHaveLength(1);
  });

  it('rejects artifact update manifests when the agent did not read the current head', async () => {
    const topicId = createTopic(db, 'test');
    const { artifact } = createDocumentArtifact(db, {
      topicId,
      kind: 'plan',
      title: 'Plan',
      body: '# v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: '# v2',
    });

    const agentScript = path.join(tmpDir, 'artifact-blind-agent.js');
    fs.writeFileSync(
      agentScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const out = process.env.TEEPEE_OUTPUT_DIR;",
        "fs.writeFileSync(path.join(out, 'files', 'plan.md'), '# blind update');",
        "fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "  { op: 'update', artifact_id: 1, base_version: 2, path: 'files/plan.md' }",
        "] }));",
        "fs.writeFileSync(path.join(out, 'response.md'), 'Blind update attempted.');",
        "console.log('done');",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        artifact_provider: { command: 'node artifact-blind-agent.js' },
      },
      agents: {
        coder: { provider: 'artifact_provider', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder aggiorna il documento');

    expect(getArtifactVersions(db, artifact.id)).toHaveLength(2);
    const job = db.prepare('SELECT status, output_message_id, error FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.output_message_id).toBeNull();
    expect(job.error).toContain('requires read-current');
    const events = db.prepare(`SELECT kind, payload FROM events ORDER BY id`).all() as Array<{ kind: string; payload: string }>;
    expect(events.some((event) => event.kind === 'agent.job.retrying' && event.payload.includes('requires read-current'))).toBe(true);
    expect(events.some((event) => event.kind === 'artifact.ingest.error' && event.payload.includes('requires read-current'))).toBe(true);
    expect(events.some((event) => event.kind === 'agent.job.failed' && event.payload.includes('requires read-current'))).toBe(true);
    expect(callbacks.calls.onJobRetrying).toHaveLength(1);
    expect(callbacks.calls.onJobCompleted).toHaveLength(0);
    expect(callbacks.calls.onJobFailed).toHaveLength(1);
  });

  it('auto-repairs a recoverable artifact write error once and commits only the final reply', async () => {
    const topicId = createTopic(db, 'test');
    const { artifact } = createDocumentArtifact(db, {
      topicId,
      kind: 'plan',
      title: 'Plan',
      body: '# v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: '# v2',
    });

    const agentScript = path.join(tmpDir, 'artifact-auto-repair-agent.js');
    fs.writeFileSync(
      agentScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const input = fs.readFileSync(0, 'utf8');",
        "const out = process.env.TEEPEE_OUTPUT_DIR;",
        "if (!input.includes('[artifact-write-error]')) {",
        "  fs.writeFileSync(path.join(out, 'files', 'plan.md'), '# blind update');",
        "  fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "    { op: 'update', artifact_id: 1, base_version: 2, path: 'files/plan.md' }",
        "  ] }));",
        "  fs.writeFileSync(path.join(out, 'response.md'), 'First attempt');",
        "  console.log('first attempt');",
        "} else if (!input.includes('[artifact-op-results]\\n{')) {",
        "  fs.writeFileSync(path.join(out, 'artifact-ops.json'), JSON.stringify({ operations: [",
        "    { op_id: 'r1', op: 'read-current', artifact_id: 1 }",
        "  ] }));",
        "  console.log('repair requesting read-current');",
        "} else {",
        "  const jsonText = input.split('[artifact-op-results]\\n')[1].split('\\n\\n[artifact-write-error]')[0];",
        "  const parsed = JSON.parse(jsonText);",
        "  const current = parsed.results.find((r) => r.op === 'read-current');",
        "  fs.writeFileSync(path.join(out, 'files', 'plan.md'), `# repaired\\n\\nBase: ${current.version}`);",
        "  fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "    { op: 'update', artifact_id: 1, base_version: 'current', path: 'files/plan.md' }",
        "  ] }));",
        "  fs.writeFileSync(path.join(out, 'response.md'), 'Second attempt repaired');",
        "  console.log('second attempt');",
        "}",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        artifact_provider: { command: 'node artifact-auto-repair-agent.js' },
      },
      agents: {
        coder: { provider: 'artifact_provider', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder aggiorna il documento');

    const versions = getArtifactVersions(db, artifact.id);
    expect(versions).toHaveLength(3);
    expect(versions[2].body).toContain('Base: 2');
    const job = db.prepare('SELECT status, output_message_id, error FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.output_message_id).toBeTruthy();
    const agentMessages = db.prepare("SELECT body FROM messages WHERE topic_id = ? AND author_type = 'agent' ORDER BY id").all(topicId) as Array<{ body: string }>;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0].body).toBe('Second attempt repaired');
    const events = db.prepare(`SELECT kind, payload FROM events ORDER BY id`).all() as Array<{ kind: string; payload: string }>;
    expect(events.some((event) => event.kind === 'agent.job.retrying')).toBe(true);
    expect(events.some((event) => event.kind === 'agent.job.failed')).toBe(false);
    expect(callbacks.calls.onJobRetrying).toHaveLength(1);
    expect(callbacks.calls.onJobCompleted).toHaveLength(1);
  });

  it('fails after a single auto-repair attempt without leaving a ghost agent message', async () => {
    const topicId = createTopic(db, 'test');
    const { artifact } = createDocumentArtifact(db, {
      topicId,
      kind: 'plan',
      title: 'Plan',
      body: '# v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: '# v2',
    });

    const agentScript = path.join(tmpDir, 'artifact-auto-repair-fail-agent.js');
    fs.writeFileSync(
      agentScript,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const input = fs.readFileSync(0, 'utf8');",
        "const out = process.env.TEEPEE_OUTPUT_DIR;",
        "const response = input.includes('[artifact-write-error]') ? 'Second attempt still broken' : 'First attempt broken';",
        "fs.writeFileSync(path.join(out, 'files', 'plan.md'), '# blind update');",
        "fs.writeFileSync(path.join(out, 'artifacts.json'), JSON.stringify({ documents: [",
        "  { op: 'update', artifact_id: 1, base_version: 2, path: 'files/plan.md' }",
        "] }));",
        "fs.writeFileSync(path.join(out, 'response.md'), response);",
        "console.log(response);",
      ].join('\n')
    );

    const config = makeConfig({
      providers: {
        artifact_provider: { command: 'node artifact-auto-repair-fail-agent.js' },
      },
      agents: {
        coder: { provider: 'artifact_provider', capability: 'host_allowed', profile: 'trusted' },
      },
    });
    const callbacks = makeCallbacks();
    const orch = new Orchestrator(db, config, tmpDir, callbacks);

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder aggiorna il documento');

    expect(getArtifactVersions(db, artifact.id)).toHaveLength(2);
    const job = db.prepare('SELECT status, output_message_id, error FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
    expect(job.status).toBe('failed');
    expect(job.output_message_id).toBeNull();
    expect(job.error).toContain('requires read-current');
    const agentMessageCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE topic_id = ? AND author_type = 'agent'").get(topicId) as { count: number };
    expect(agentMessageCount.count).toBe(0);
    expect(callbacks.calls.onJobRetrying).toHaveLength(1);
    expect(callbacks.calls.onJobFailed).toHaveLength(1);
    expect(callbacks.calls.onJobCompleted).toHaveLength(0);
  });
});
