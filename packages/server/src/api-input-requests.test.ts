import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { createSession, openDb } from 'teepee-core';
import { startServer } from './index.js';

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: object,
  cookie?: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/auth/session', method: 'GET' }, () => resolve());
      req.on('error', () => setTimeout(check, 50));
      req.end();
    };
    check();
  });
}

function connectWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Cookie: cookie },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextEvent(ws: WebSocket, matcher: (event: any) => boolean, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket event'));
    }, timeoutMs);

    const onMessage = (raw: any) => {
      const event = JSON.parse(raw.toString());
      if (!matcher(event)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    };

    ws.on('message', onMessage);
  });
}

function writeConfig(dir: string): string {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });

  const agentScript = path.join(dir, 'human-input-agent.js');
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
    "    prompt: 'Proceed?',",
    "    required: true,",
    "    allow_comment: true,",
    "    expires_in_sec: 600",
    "  }));",
    "  fs.writeFileSync(path.join(out, 'response.md'), 'Serve approvazione umana.');",
    "  console.log('waiting');",
    "} else {",
    "  const jsonText = input.split('[user-input-results]\\n')[1].split('\\n\\n[messages]')[0];",
    "  const parsed = JSON.parse(jsonText);",
    "  fs.writeFileSync(path.join(out, 'response.md'), `Decisione finale: ${parsed.value} | comment=${parsed.comment || ''}`);",
    "  console.log('done');",
    "}",
  ].join('\n'));

  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: private
teepee:
  name: input-test
providers:
  human_input:
    command: "node human-input-agent.js"
agents:
  coder:
    provider: human_input
roles:
  owner:
    coder: trusted
  collaborator: {}
  observer: {}
`);

  return configPath;
}

describe('job input request API', () => {
  let port: number;
  let cookie: string;
  let close: () => void;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-api-input-'));
    const configPath = writeConfig(tmpDir);
    port = 32000 + Math.floor(Math.random() * 4000);
    ({ close } = startServer(configPath, port));
    await waitForServer(port);

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const sessionId = createSession(db, 'owner@localhost');
    cookie = `teepee_session=${sessionId}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers a pending request through HTTP and emits resume/completion websocket events', async () => {
    const createdTopic = await request(port, 'POST', '/api/topics', { name: 'answer-flow' }, cookie);
    expect(createdTopic.status).toBe(201);
    const topicId = createdTopic.body.id as number;

    const ws = await connectWs(port, cookie);
    ws.send(JSON.stringify({ type: 'topic.join', topicId }));
    await nextEvent(ws, (event) => event.type === 'topic.history' && event.topicId === topicId);

    const waitingInputEvent = nextEvent(ws, (event) => event.type === 'agent.job.waiting_input' && event.topicId === topicId);
    const postMessage = await request(port, 'POST', `/api/topics/${topicId}/messages`, { text: '@coder procedi' }, cookie);
    expect(postMessage.status).toBe(201);

    const waiting = await waitingInputEvent;
    expect(waiting.request.title).toBe('Approval needed');

    const listRequests = await request(port, 'GET', `/api/topics/${topicId}/input-requests`, undefined, cookie);
    expect(listRequests.status).toBe(200);
    expect(listRequests.body).toHaveLength(1);
    expect(listRequests.body[0].status).toBe('pending');

    const answeredEvent = nextEvent(ws, (event) => event.type === 'job.input.answered' && event.requestId === waiting.request.requestId);
    const resumedEvent = nextEvent(ws, (event) => event.type === 'agent.job.resumed' && event.requestId === waiting.request.requestId);
    const completedEvent = nextEvent(ws, (event) => event.type === 'agent.job.completed' && event.jobId === waiting.jobId);

    const answer = await request(
      port,
      'POST',
      `/api/input-requests/${waiting.request.requestId}/answer`,
      { value: true, comment: 'ship it' },
      cookie
    );
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);

    await answeredEvent;
    await resumedEvent;
    await completedEvent;

    const pendingAfterAnswer = await request(port, 'GET', `/api/jobs/${waiting.jobId}/input-request`, undefined, cookie);
    expect(pendingAfterAnswer.status).toBe(404);

    const messages = await request(port, 'GET', `/api/topics/${topicId}/messages?limit=20`, undefined, cookie);
    expect(messages.status).toBe(200);
    expect(messages.body.some((message: any) => message.author_type === 'system' && message.body.includes('Decisione registrata da owner'))).toBe(true);
    expect(messages.body.some((message: any) => message.author_type === 'agent' && message.body.includes('Decisione finale: true | comment=ship it'))).toBe(true);

    ws.close();
  });

  it('cancels a pending request through HTTP and emits the cancellation event', async () => {
    const createdTopic = await request(port, 'POST', '/api/topics', { name: 'cancel-flow' }, cookie);
    expect(createdTopic.status).toBe(201);
    const topicId = createdTopic.body.id as number;

    const ws = await connectWs(port, cookie);
    ws.send(JSON.stringify({ type: 'topic.join', topicId }));
    await nextEvent(ws, (event) => event.type === 'topic.history' && event.topicId === topicId);

    const waitingInputEvent = nextEvent(ws, (event) => event.type === 'agent.job.waiting_input' && event.topicId === topicId);
    const postMessage = await request(port, 'POST', `/api/topics/${topicId}/messages`, { text: '@coder procedi' }, cookie);
    expect(postMessage.status).toBe(201);

    const waiting = await waitingInputEvent;
    const cancelledEvent = nextEvent(ws, (event) => event.type === 'job.input.cancelled' && event.requestId === waiting.request.requestId);

    const cancel = await request(
      port,
      'POST',
      `/api/input-requests/${waiting.request.requestId}/cancel`,
      {},
      cookie
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);

    await cancelledEvent;

    const requests = await request(port, 'GET', `/api/topics/${topicId}/input-requests`, undefined, cookie);
    expect(requests.status).toBe(200);
    expect(requests.body[0].status).toBe('cancelled');

    const messages = await request(port, 'GET', `/api/topics/${topicId}/messages?limit=20`, undefined, cookie);
    expect(messages.body.some((message: any) => message.author_type === 'system' && message.body.includes('Richiesta annullata: Approval needed'))).toBe(true);

    ws.close();
  });
});
