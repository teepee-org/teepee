import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSession } from 'teepee-core';
import { startServer } from './index.js';

function request(
  port: number,
  method: string,
  urlPath: string,
  cookie?: string
): Promise<{ status: number; body: any }> {
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
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
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

function writeConfig(dir: string, name: string, mode: 'private' | 'shared' = 'private') {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: ${mode}
teepee:
  name: ${name}
providers:
  echo:
    command: "cat"
agents:
  bot:
    provider: echo
`);
  return configPath;
}

describe('/api/project mode and bindHost', () => {
  let privateServer: http.Server;
  let privateClose: () => void;
  let privatePort: number;
  let privateCookie: string;
  let privateTmpDir: string;
  let privateConfigPath: string;

  let sharedServer: http.Server;
  let sharedClose: () => void;
  let sharedPort: number;
  let sharedCookie: string;
  let sharedTmpDir: string;
  let sharedConfigPath: string;

  beforeAll(async () => {
    privateTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-api-private-'));
    privateConfigPath = writeConfig(privateTmpDir, 'private-test', 'private');
    privatePort = 31000 + Math.floor(Math.random() * 5000);
    const privateResult = startServer(privateConfigPath, privatePort);
    privateServer = privateResult.server;
    privateClose = privateResult.close;

    sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-api-shared-'));
    sharedConfigPath = writeConfig(sharedTmpDir, 'shared-test', 'shared');
    sharedPort = privatePort + 1;
    const sharedResult = startServer(sharedConfigPath, sharedPort);
    sharedServer = sharedResult.server;
    sharedClose = sharedResult.close;

    await Promise.all([waitForServer(privatePort), waitForServer(sharedPort)]);

    // Create sessions directly in the DB (owner@localhost is auto-created by ensureOwner)
    const { openDb } = await import('teepee-core');
    const privateDb = openDb(path.join(privateTmpDir, '.teepee', 'db.sqlite'));
    const privateSessionId = createSession(privateDb, 'owner@localhost');
    privateCookie = `teepee_session=${privateSessionId}`;
    privateDb.close();

    const sharedDb = openDb(path.join(sharedTmpDir, '.teepee', 'db.sqlite'));
    const sharedSessionId = createSession(sharedDb, 'owner@localhost');
    sharedCookie = `teepee_session=${sharedSessionId}`;
    sharedDb.close();
  });

  afterAll(() => {
    privateClose();
    sharedClose();
    fs.rmSync(privateTmpDir, { recursive: true, force: true });
    fs.rmSync(sharedTmpDir, { recursive: true, force: true });
  });

  it('returns mode "private" for private config', async () => {
    const res = await request(privatePort, 'GET', '/api/project', privateCookie);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('private');
  });

  it('returns mode "shared" for shared config', async () => {
    const res = await request(sharedPort, 'GET', '/api/project', sharedCookie);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('shared');
  });

  it('returns bindHost defaulting to 127.0.0.1', async () => {
    const res = await request(privatePort, 'GET', '/api/project', privateCookie);
    expect(res.status).toBe(200);
    expect(res.body.bindHost).toBe('127.0.0.1');
  });

  it('includes name and language in project response', async () => {
    const res = await request(privatePort, 'GET', '/api/project', privateCookie);
    expect(res.body.name).toBe('private-test');
  });

  it('auto-migrates legacy startup config to version 2 with backup', () => {
    const privateConfig = fs.readFileSync(privateConfigPath, 'utf-8');
    const sharedConfig = fs.readFileSync(sharedConfigPath, 'utf-8');

    expect(privateConfig).toContain('version: 2');
    expect(sharedConfig).toContain('version: 2');
    expect(fs.existsSync(path.join(privateTmpDir, '.teepee', 'config.v1.bak.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(sharedTmpDir, '.teepee', 'config.v1.bak.yaml'))).toBe(true);
  });
});
