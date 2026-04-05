import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { startServer } from './index.js';

let server: http.Server;
let close: () => void;
let port: number;
let tmpDir: string;
let ownerSecret: string;

function request(
  method: string,
  urlPath: string,
  body?: object,
  cookie?: string
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      }},
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractCookie(headers: http.IncomingHttpHeaders): string | undefined {
  const sc = headers['set-cookie'];
  if (!sc) return undefined;
  const raw = Array.isArray(sc) ? sc[0] : sc;
  const match = raw.match(/teepee_session=([^;]+)/);
  return match ? `teepee_session=${match[1]}` : undefined;
}

function connectWs(cookie?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function wsMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-auth-test-'));
  const configPath = path.join(tmpDir, 'teepee.yaml');
  fs.writeFileSync(configPath, `
teepee:
  name: auth-test
providers:
  echo:
    command: "cat"
agents:
  bot:
    provider: echo
`);

  // Use a random high port
  port = 30000 + Math.floor(Math.random() * 10000);

  const result = startServer(configPath, port);
  server = result.server;
  close = result.close;

  // Wait for server to listen
  await new Promise<void>((resolve) => {
    const check = () => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/auth/session', method: 'GET' }, () => resolve());
      req.on('error', () => setTimeout(check, 50));
      req.end();
    };
    check();
  });

  // Capture owner secret from stdout (we can't easily, so use the owner login endpoint)
  // Instead, we'll get owner session by finding the secret in .teepee dir
  // Actually, we need to find the secret. The cleanest way: call every /auth/owner/<guess> — not feasible.
  // For tests, we'll authenticate by directly creating a session in the DB.
  // But we don't have direct DB access here. Let's use a different approach:
  // just test that anonymous access is denied.
});

afterAll(() => {
  close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HTTP auth gate', () => {
  it('GET /api/topics returns 401 without session', async () => {
    const res = await request('GET', '/api/topics');
    expect(res.status).toBe(401);
  });

  it('GET /api/users returns 401 without session', async () => {
    const res = await request('GET', '/api/users');
    expect(res.status).toBe(401);
  });

  it('GET /api/project returns 401 without session', async () => {
    const res = await request('GET', '/api/project');
    expect(res.status).toBe(401);
  });

  it('GET /api/agents returns 401 without session', async () => {
    const res = await request('GET', '/api/agents');
    expect(res.status).toBe(401);
  });

  it('POST /api/topics returns 401 without session', async () => {
    const res = await request('POST', '/api/topics', { name: 'test' });
    expect(res.status).toBe(401);
  });

  it('POST /api/topics/:id/messages returns 401 without session', async () => {
    const res = await request('POST', '/api/topics/1/messages', { text: 'hi' });
    expect(res.status).toBe(401);
  });

  it('POST /api/admin/invite returns 401 without session', async () => {
    const res = await request('POST', '/api/admin/invite', { email: 'x@y.com' });
    expect(res.status).toBe(401);
  });

  it('GET /api/status returns 401 without session', async () => {
    const res = await request('GET', '/api/status');
    expect(res.status).toBe(401);
  });
});

describe('Auth endpoints remain public', () => {
  it('GET /auth/session returns 401 but does not error', async () => {
    const res = await request('GET', '/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });

  it('GET /auth/invite/:token returns 400 for bad token', async () => {
    const res = await request('GET', '/auth/invite/0000000000000000000000000000000000000000000000000000000000000000');
    expect(res.status).toBe(400);
  });

  it('POST /auth/invite/accept returns 400 for bad token', async () => {
    const res = await request('POST', '/auth/invite/accept', { token: 'bad', handle: 'test' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/logout returns 200 even without session', async () => {
    const res = await request('POST', '/auth/logout');
    expect(res.status).toBe(200);
  });

  it('GET /auth/owner/:bad-secret returns 403', async () => {
    const res = await request('GET', '/auth/owner/0000000000000000000000000000000000');
    expect(res.status).toBe(403);
  });

  it('Static assets remain accessible', async () => {
    const res = await request('GET', '/');
    // May be 200 (if dist exists) or 404, but never 401
    expect(res.status).not.toBe(401);
  });
});

describe('WebSocket auth', () => {
  it('unauthenticated client gets error on topic.join', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ type: 'topic.join', topicId: 1 }));
    const msg = await wsMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('Not authenticated');
    ws.close();
  });

  it('unauthenticated client gets error on message.send', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ type: 'message.send', topicId: 1, body: 'hi' }));
    const msg = await wsMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('Not authenticated');
    ws.close();
  });

  it('unauthenticated client gets error on command', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ type: 'command', topicId: 1, command: 'topic.language', language: 'it' }));
    const msg = await wsMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('Not authenticated');
    ws.close();
  });
});

describe('No implicit owner fallback', () => {
  it('HTTP POST message does not fallback to owner identity', async () => {
    const res = await request('POST', '/api/topics/1/messages', { text: 'test', email: 'attacker@evil.com', authorName: 'attacker' });
    expect(res.status).toBe(401);
  });
});
