import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { createSession, createUser } from 'teepee-core';
import { startServer } from './index.js';

function request(
  port: number,
  method: string,
  urlPath: string,
  cookie?: string,
  body?: object
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }},
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
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

function writeConfig(dir: string) {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: shared
teepee:
  name: topic-test
providers:
  echo:
    command: "cat"
agents:
  bot:
    provider: echo
`);
  return configPath;
}

describe('POST /api/topics with parentTopicId', () => {
  let server: http.Server;
  let close: () => void;
  let port: number;
  let cookie: string;
  let observerCookie: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-topics-'));
    const config = writeConfig(tmpDir);
    port = 32000 + Math.floor(Math.random() * 5000);
    const result = startServer(config, port);
    server = result.server;
    close = result.close;
    await waitForServer(port);

    const { openDb } = await import('teepee-core');
    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const sid = createSession(db, 'owner@localhost');
    cookie = `teepee_session=${sid}`;

    // Create an observer
    createUser(db, 'observer@test.com', 'observer');
    const obsSession = createSession(db, 'observer@test.com');
    observerCookie = `teepee_session=${obsSession}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a root topic when parentTopicId is omitted', async () => {
    const res = await request(port, 'POST', '/api/topics', cookie, { name: 'Root' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Root');
    expect(res.body.parent_topic_id).toBeNull();
  });

  it('creates a child topic when parentTopicId is given', async () => {
    // First create a parent
    const parent = await request(port, 'POST', '/api/topics', cookie, { name: 'Parent' });
    expect(parent.status).toBe(201);

    const child = await request(port, 'POST', '/api/topics', cookie, {
      name: 'Child',
      parentTopicId: parent.body.id,
    });
    expect(child.status).toBe(201);
    expect(child.body.name).toBe('Child');
    expect(child.body.parent_topic_id).toBe(parent.body.id);
  });

  it('returns full topic shape from POST /api/topics', async () => {
    const res = await request(port, 'POST', '/api/topics', cookie, { name: 'Full Shape' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('sort_order');
    expect(res.body).toHaveProperty('parent_topic_id');
    expect(res.body).toHaveProperty('archived');
  });

  it('observer cannot create topics', async () => {
    const res = await request(port, 'POST', '/api/topics', observerCookie, { name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/presence', () => {
  let server: http.Server;
  let close: () => void;
  let port: number;
  let cookie: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-presence-'));
    const config = writeConfig(tmpDir);
    port = 33000 + Math.floor(Math.random() * 5000);
    const result = startServer(config, port);
    server = result.server;
    close = result.close;
    await waitForServer(port);

    const { openDb } = await import('teepee-core');
    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const sid = createSession(db, 'owner@localhost');
    cookie = `teepee_session=${sid}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an array from GET /api/presence', async () => {
    const res = await request(port, 'GET', '/api/presence', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('presence entries have expected fields', async () => {
    // Without WS connections, presence should be empty
    const res = await request(port, 'GET', '/api/presence', cookie);
    expect(res.status).toBe(200);
    // No WebSocket clients connected, so empty
    expect(res.body.length).toBe(0);
  });
});

// ── WebSocket presence tests ──

/** Connect WS and return [ws, firstPresenceMessage]. Registers the message listener
 *  before the connection opens so the initial presence.changed broadcast is captured. */
function connectWsWithPresence(
  port: number, cookie: string
): Promise<[WebSocket, any]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Cookie: cookie } });
    ws.on('error', reject);
    ws.on('message', function handler(raw: any) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'presence.changed') {
        ws.removeListener('message', handler);
        resolve([ws, msg]);
      }
    });
  });
}

function connectWs(port: number, cookie: string): Promise<WebSocket> {
  return connectWsWithPresence(port, cookie).then(([ws]) => ws);
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (raw: any) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function waitForPresenceMatch(
  ws: WebSocket,
  predicate: (entry: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timeout waiting for matching presence.changed'));
    }, timeoutMs);
    const handler = (raw: any) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'presence.changed') return;
      const match = msg.presence.find(predicate);
      if (!match) return;
      clearTimeout(timer);
      ws.removeListener('message', handler);
      resolve(match);
    };
    ws.on('message', handler);
  });
}

describe('WebSocket presence events', () => {
  let server: http.Server;
  let close: () => void;
  let port: number;
  let cookie: string;
  let cookie2: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-ws-presence-'));
    const config = writeConfig(tmpDir);
    port = 34000 + Math.floor(Math.random() * 5000);
    const result = startServer(config, port, { idleThresholdMs: 300, idleCheckIntervalMs: 50 });
    server = result.server;
    close = result.close;
    await waitForServer(port);

    const { openDb } = await import('teepee-core');
    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const sid = createSession(db, 'owner@localhost');
    cookie = `teepee_session=${sid}`;

    createUser(db, 'alice@test.com', 'collaborator');
    const sid2 = createSession(db, 'alice@test.com');
    cookie2 = `teepee_session=${sid2}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('broadcasts presence.changed on connect', async () => {
    const [ws1, msg] = await connectWsWithPresence(port, cookie);
    expect(msg.presence).toBeInstanceOf(Array);
    expect(msg.presence.length).toBeGreaterThanOrEqual(1);
    expect(msg.presence[0]).toHaveProperty('sessionId');
    expect(msg.presence[0]).toHaveProperty('displayName');
    expect(msg.presence[0]).toHaveProperty('role');
    expect(msg.presence[0]).toHaveProperty('state');
    ws1.close();
  });

  it('broadcasts presence.changed on active topic switch', async () => {
    const [ws1] = await connectWsWithPresence(port, cookie);

    // Create a topic first via REST
    const topicRes = await request(port, 'POST', '/api/topics', cookie, { name: 'WS Test' });
    const topicId = topicRes.body.id;

    // Send active topic and wait for broadcast
    const pendingMsg = waitForMessage(ws1, 'presence.changed');
    ws1.send(JSON.stringify({ type: 'presence.active_topic', topicId }));
    const msg = await pendingMsg;
    const entry = msg.presence.find((p: any) => p.activeTopicId === topicId);
    expect(entry).toBeTruthy();
    expect(entry.state).toBe('active');

    ws1.close();
  });

  it('broadcasts presence.changed on disconnect', async () => {
    const [ws1] = await connectWsWithPresence(port, cookie);

    // Connect second client — use connectWsWithPresence so we also consume
    // the ws2-connect broadcast that ws1 would otherwise see
    const pendingWs1Sees2 = waitForMessage(ws1, 'presence.changed');
    const [ws2] = await connectWsWithPresence(port, cookie2);
    await pendingWs1Sees2; // consume ws2-connect broadcast on ws1

    // Now disconnect ws1 and ws2 should get notified
    const pendingDisconnect = waitForMessage(ws2, 'presence.changed');
    ws1.close();
    const msg = await pendingDisconnect;
    // Only ws2 (alice) should remain
    expect(msg.presence.length).toBe(1);
    expect(msg.presence[0].displayName).not.toBe('owner@localhost');

    ws2.close();
  });

  it('presence entries include role field', async () => {
    const [ws1, msg] = await connectWsWithPresence(port, cookie);
    // Find the owner entry — other sessions from prior tests may linger
    const ownerEntry = msg.presence.find((p: any) => p.role === 'owner');
    expect(ownerEntry).toBeTruthy();
    expect(ownerEntry.role).toBe('owner');
    ws1.close();
  });

  it('broadcasts presence.changed when a client becomes idle', async () => {
    const [ws1] = await connectWsWithPresence(port, cookie);
    const ownerEntry = await waitForPresenceMatch(
      ws1,
      (p) => p.role === 'owner' && p.state === 'idle',
      2000
    );
    expect(ownerEntry.state).toBe('idle');
    ws1.close();
  });
});
