import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { Orchestrator, type OrchestratorCallbacks } from './orchestrator.js';
import { openDb } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { createUser, activateUser, getUser } from './db/users.js';
import { createTopic } from './db/topics.js';
import { getMessages } from './db/messages.js';
import { getJob } from './db/jobs.js';
import { getPendingJobInputRequest, getJobInputRequestById } from './user-input/db.js';
import type { TeepeeConfig } from './config.js';

function setupDb(): { db: DatabaseType; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-user-input-test-'));
  const db = openDb(path.join(tmpDir, 'db.sqlite'));
  runMigrations(db);
  return { db, tmpDir };
}

function setupUsers(db: DatabaseType) {
  createUser(db, 'owner@test.com', 'owner');
  activateUser(db, 'owner@test.com', 'owner');
  createUser(db, 'user@test.com', 'collaborator');
  activateUser(db, 'user@test.com', 'normaluser');
  createUser(db, 'peer@test.com', 'collaborator');
  activateUser(db, 'peer@test.com', 'peer');
}

function makeCallbacks(): OrchestratorCallbacks & { calls: Record<string, any[][]> } {
  const calls: Record<string, any[][]> = {
    onJobStarted: [],
    onJobStream: [],
    onJobRetrying: [],
    onJobWaitingInput: [],
    onJobResumed: [],
    onJobCompleted: [],
    onJobFailed: [],
    onSystemMessage: [],
  };
  return {
    calls,
    onJobStarted: (...args: any[]) => { calls.onJobStarted.push(args); },
    onJobStream: (...args: any[]) => { calls.onJobStream.push(args); },
    onJobRetrying: (...args: any[]) => { calls.onJobRetrying.push(args); },
    onJobWaitingInput: (...args: any[]) => { calls.onJobWaitingInput.push(args); },
    onJobResumed: (...args: any[]) => { calls.onJobResumed.push(args); },
    onJobCompleted: (...args: any[]) => { calls.onJobCompleted.push(args); },
    onJobFailed: (...args: any[]) => { calls.onJobFailed.push(args); },
    onSystemMessage: (...args: any[]) => { calls.onSystemMessage.push(args); },
  };
}

function makeConfig(agentCommand: string): TeepeeConfig {
  return {
    version: 1,
    mode: 'private',
    teepee: { name: 'test', language: 'en', demo: { enabled: false, topic_name: 'demo', hotkey: 'F1', delay_ms: 1200 } },
    server: { trust_proxy: false, cors_allowed_origins: [], auth_rate_limit_window_seconds: 60, auth_rate_limit_max_requests: 100 },
    providers: {
      human_input: { command: agentCommand },
    },
    agents: {
      coder: { provider: 'human_input' },
    },
    roles: {
      owner: { coder: 'trusted' },
      collaborator: { coder: 'trusted' },
      observer: {},
    },
    limits: { max_agents_per_message: 5, max_jobs_per_user_per_minute: 100, max_chain_depth: 2, max_total_jobs_per_chain: 10 },
    security: {
      sandbox: { runner: 'bubblewrap', empty_home: true, private_tmp: true, forward_env: [] },
    },
  };
}

function writeHumanInputAgent(tmpDir: string): string {
  const agentScript = path.join(tmpDir, 'human-input-agent.js');
  fs.writeFileSync(agentScript, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const input = fs.readFileSync(0, 'utf8');",
    "const out = process.env.TEEPEE_OUTPUT_DIR;",
    "if (!input.includes('\\n[user-input-results]\\n')) {",
    "  fs.writeFileSync(path.join(out, 'user-input.json'), JSON.stringify({",
    "    request_key: 'approval',",
    "    title: 'Approval needed',",
    "    kind: 'confirm',",
    "    prompt: 'Proceed with deploy?',",
    "    required: true,",
    "    allow_comment: true,",
    "    expires_in_sec: 600",
    "  }));",
    "  fs.writeFileSync(path.join(out, 'response.md'), 'Serve approvazione umana.');",
    "  console.log('waiting');",
    "} else {",
    "  const jsonText = input.split('[user-input-results]\\n')[1].split('\\n\\n[messages]')[0];",
    "  const parsed = JSON.parse(jsonText);",
    "  fs.writeFileSync(path.join(out, 'response.md'), `Risposta finale: ${parsed.value} | comment=${parsed.comment || ''} | requester=${parsed.answered_by_handle || parsed.answered_by_user_id}`);",
    "  console.log('done');",
    "}",
  ].join('\n'));
  return agentScript;
}

describe('Orchestrator user-input checkpoints', () => {
  let db: DatabaseType;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
    setupUsers(db);
  });

  it('pauses for human input and resumes the same job with recorded decision context', async () => {
    const callbacks = makeCallbacks();
    const config = makeConfig(`node ${path.basename(writeHumanInputAgent(tmpDir))}`);
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    const topicId = createTopic(db, 'checkpoint');
    const owner = getUser(db, 'owner@test.com');

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder procedi');

    const waitingCall = callbacks.calls.onJobWaitingInput[0];
    expect(waitingCall).toBeTruthy();
    const request = waitingCall[3];
    expect(request.title).toBe('Approval needed');
    expect(getPendingJobInputRequest(db, request.jobId)?.requestId).toBe(request.requestId);

    const pausedJob = getJob(db, request.jobId) as { status: string; waiting_request_id: number | null };
    expect(pausedJob.status).toBe('waiting_input');
    expect(pausedJob.waiting_request_id).toBe(request.requestId);

    const resumed = await orch.resumeJobFromUserInput(request.requestId, owner!.id, { value: true, comment: 'ship it' });

    expect(resumed.requestId).toBe(request.requestId);
    expect(callbacks.calls.onJobResumed).toHaveLength(1);
    expect(callbacks.calls.onJobCompleted).toHaveLength(1);
    expect(getJobInputRequestById(db, request.requestId)?.status).toBe('answered');

    const job = getJob(db, request.jobId) as { status: string; resume_count: number; waiting_request_id: number | null };
    expect(job.status).toBe('done');
    expect(job.resume_count).toBe(1);
    expect(job.waiting_request_id).toBeNull();

    const messages = getMessages(db, topicId, 20);
    expect(messages.some((message) => message.author_type === 'system' && message.body.includes('Decisione registrata da owner'))).toBe(true);
    expect(messages.some((message) => message.author_type === 'agent' && message.body.includes('Risposta finale: true | comment=ship it | requester=owner'))).toBe(true);
  });

  it('rejects answers from users who did not start the job', async () => {
    const callbacks = makeCallbacks();
    const config = makeConfig(`node ${path.basename(writeHumanInputAgent(tmpDir))}`);
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    const topicId = createTopic(db, 'checkpoint');
    const peer = getUser(db, 'peer@test.com');

    await orch.handleMessage(topicId, 'owner@test.com', 'owner', '@coder procedi');
    const request = callbacks.calls.onJobWaitingInput[0][3];

    await expect(
      orch.resumeJobFromUserInput(request.requestId, peer!.id, { value: true })
    ).rejects.toThrow('Only the user who started the job can answer this request');

    expect(getJobInputRequestById(db, request.requestId)?.status).toBe('pending');
    expect((getJob(db, request.jobId) as { status: string }).status).toBe('waiting_input');
    expect(callbacks.calls.onJobResumed).toHaveLength(0);
  });

  it('allows an owner to cancel a pending request started by another user', async () => {
    const callbacks = makeCallbacks();
    const config = makeConfig(`node ${path.basename(writeHumanInputAgent(tmpDir))}`);
    const orch = new Orchestrator(db, config, tmpDir, callbacks);
    const topicId = createTopic(db, 'checkpoint');
    const owner = getUser(db, 'owner@test.com');

    await orch.handleMessage(topicId, 'user@test.com', 'normaluser', '@coder procedi');
    const request = callbacks.calls.onJobWaitingInput[0][3];

    const cancelled = await orch.cancelJobFromUserInput(request.requestId, owner!.id, 'owner');

    expect(cancelled.topicId).toBe(topicId);
    expect(getJobInputRequestById(db, request.requestId)?.status).toBe('cancelled');
    const job = getJob(db, request.jobId) as { status: string; error: string | null };
    expect(job.status).toBe('cancelled');
    expect(job.error).toBe('User input request cancelled');

    const messages = getMessages(db, topicId, 20);
    expect(messages.some((message) => message.author_type === 'system' && message.body.includes('Richiesta annullata: Approval needed'))).toBe(true);
  });
});
