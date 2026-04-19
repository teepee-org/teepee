import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { createInviteToken, createUser, openDb } from 'teepee-core';
import { startServer } from './index.js';

let server: http.Server;
let close: () => void;
let port: number;
let tmpDir: string;

function createInvite(email: string): string {
  const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
  createUser(db, email, 'collaborator');
  const token = createInviteToken(db, email);
  db.close();
  return token;
}

function request(
  method: string,
  urlPath: string,
  body?: object,
  cookie?: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(extraHeaders || {}),
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

function connectWsExpectUnauthorized(cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode || 0);
      ws.terminate();
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('WebSocket unexpectedly connected'));
    });
    ws.on('error', () => {
      // expected after unexpected-response on some runtimes
    });
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-auth-test-'));
  const teepeeDir = path.join(tmpDir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: shared
teepee:
  name: auth-test
server:
  auth_rate_limit_max_requests: 2
  trust_proxy: true
  cors_allowed_origins:
    - https://app.example.com
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

  it('rate limits repeated owner auth attempts', async () => {
    await request('GET', '/auth/owner/1111111111111111111111111111111111');
    await request('GET', '/auth/owner/2222222222222222222222222222222222');
    const res = await request('GET', '/auth/owner/3333333333333333333333333333333333');
    expect(res.status).toBe(429);
  });

  it('blocks disallowed CORS origins', async () => {
    const res = await request('GET', '/auth/session', undefined, undefined, {
      Origin: 'https://evil.example.com',
    });
    expect(res.status).toBe(403);
  });

  it('allows credentialed CORS for allowlisted origin', async () => {
    const res = await request('GET', '/auth/session', undefined, undefined, {
      Origin: 'https://app.example.com',
    });
    expect(res.status).toBe(401); // not authenticated, but CORS-allowed
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('omits Allow-Credentials on same-origin requests', async () => {
    const res = await request('GET', '/auth/session', undefined, undefined, {
      Origin: `http://127.0.0.1:${port}`,
    });
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('preflight OPTIONS for allowlisted origin returns 204 with credentials header', async () => {
    const res = await request('OPTIONS', '/auth/session', undefined, undefined, {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'GET',
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
  });

  it('sets SameSite=None; Secure on session cookie for HTTPS proxy auth flows', async () => {
    const token = createInvite('proxy-cookie@test.com');
    const res = await request('POST', '/auth/invite/accept', {
      token,
      handle: 'proxycookie',
    }, undefined, {
      'X-Forwarded-Proto': 'https',
      Origin: 'https://app.example.com',
    });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toEqual([
      expect.stringContaining('teepee_session='),
    ]);
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(res.headers['set-cookie'])).toContain('SameSite=None');
    expect(String(res.headers['set-cookie'])).toContain('Secure');
  });

  it('Static assets remain accessible', async () => {
    const res = await request('GET', '/');
    // May be 200 (if dist exists) or 404, but never 401
    expect(res.status).not.toBe(401);
  });
});

describe('WebSocket auth', () => {
  it('rejects unauthenticated websocket upgrade', async () => {
    const status = await connectWsExpectUnauthorized();
    expect(status).toBe(401);
  });
});

describe('No implicit owner fallback', () => {
  it('HTTP POST message does not fallback to owner identity', async () => {
    const res = await request('POST', '/api/topics/1/messages', { text: 'test', email: 'attacker@evil.com', authorName: 'attacker' });
    expect(res.status).toBe(401);
  });
});
