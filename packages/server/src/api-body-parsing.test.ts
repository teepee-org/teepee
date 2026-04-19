import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSession, openDb } from 'teepee-core';
import { startServer } from './index.js';

function requestRaw(
  port: number,
  method: string,
  urlPath: string,
  rawBody?: string,
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
          ...(rawBody !== undefined ? { 'Content-Length': Buffer.byteLength(rawBody) } : {}),
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
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

function requestJson(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  cookie?: string
): Promise<{ status: number; body: any }> {
  return requestRaw(port, method, urlPath, body === undefined ? undefined : JSON.stringify(body), cookie);
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

function writeConfig(dir: string): string {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: shared
teepee:
  name: body-test
providers:
  echo:
    command: "cat"
agents:
  bot:
    provider: echo
`);
  return configPath;
}

describe('HTTP body parsing hardening', () => {
  let close: () => void;
  let port: number;
  let cookie: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-body-test-'));
    const configPath = writeConfig(tmpDir);
    port = 31000 + Math.floor(Math.random() * 5000);
    ({ close } = startServer(configPath, port));
    await waitForServer(port);

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const sid = createSession(db, 'owner@localhost');
    cookie = `teepee_session=${sid}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 400 Invalid JSON on authenticated JSON endpoints', async () => {
    const res = await requestRaw(port, 'POST', '/api/topics', '{"name":', cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 Invalid JSON on public auth JSON endpoints', async () => {
    const res = await requestRaw(port, 'POST', '/auth/invite/accept', '{"token":', undefined);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 413 when a default-sized JSON body exceeds the cap', async () => {
    const tooLargeName = 'x'.repeat(1024 * 1024);
    const res = await requestJson(port, 'POST', '/api/topics', { name: tooLargeName }, cookie);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });

  it('allows larger message payloads within the explicit message cap', async () => {
    const topic = await requestJson(port, 'POST', '/api/topics', { name: 'Large Message Topic' }, cookie);
    expect(topic.status).toBe(201);

    const text = 'x'.repeat(2 * 1024 * 1024);
    const res = await requestJson(port, 'POST', `/api/topics/${topic.body.id}/messages`, { text }, cookie);
    expect(res.status).toBe(201);
    expect(res.body.message.body.length).toBe(text.length);
  });
});
