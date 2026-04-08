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

function writeConfig(dir: string, name: string) {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
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

describe('/api/project securityMode and bindHost', () => {
  let secureServer: http.Server;
  let secureClose: () => void;
  let securePort: number;
  let secureCookie: string;
  let secureTmpDir: string;

  let insecureServer: http.Server;
  let insecureClose: () => void;
  let insecurePort: number;
  let insecureCookie: string;
  let insecureTmpDir: string;

  beforeAll(async () => {
    // Secure server
    secureTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-api-secure-'));
    const secureConfig = writeConfig(secureTmpDir, 'secure-test');
    securePort = 31000 + Math.floor(Math.random() * 5000);
    const secureResult = startServer(secureConfig, securePort);
    secureServer = secureResult.server;
    secureClose = secureResult.close;

    // Insecure server
    insecureTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-api-insecure-'));
    const insecureConfig = writeConfig(insecureTmpDir, 'insecure-test');
    insecurePort = securePort + 1;
    const insecureResult = startServer(insecureConfig, insecurePort, { insecure: true });
    insecureServer = insecureResult.server;
    insecureClose = insecureResult.close;

    await Promise.all([waitForServer(securePort), waitForServer(insecurePort)]);

    // Create sessions directly in the DB (owner@localhost is auto-created by ensureOwner)
    const { openDb } = await import('teepee-core');
    const secureDb = openDb(path.join(secureTmpDir, '.teepee', 'db.sqlite'));
    const secureSessionId = createSession(secureDb, 'owner@localhost');
    secureCookie = `teepee_session=${secureSessionId}`;
    secureDb.close();

    const insecureDb = openDb(path.join(insecureTmpDir, '.teepee', 'db.sqlite'));
    const insecureSessionId = createSession(insecureDb, 'owner@localhost');
    insecureCookie = `teepee_session=${insecureSessionId}`;
    insecureDb.close();
  });

  afterAll(() => {
    secureClose();
    insecureClose();
    fs.rmSync(secureTmpDir, { recursive: true, force: true });
    fs.rmSync(insecureTmpDir, { recursive: true, force: true });
  });

  it('returns securityMode "secure" when --insecure is not set', async () => {
    const res = await request(securePort, 'GET', '/api/project', secureCookie);
    expect(res.status).toBe(200);
    expect(res.body.securityMode).toBe('secure');
  });

  it('returns securityMode "insecure" when --insecure is set', async () => {
    const res = await request(insecurePort, 'GET', '/api/project', insecureCookie);
    expect(res.status).toBe(200);
    expect(res.body.securityMode).toBe('insecure');
  });

  it('returns bindHost defaulting to 127.0.0.1', async () => {
    const res = await request(securePort, 'GET', '/api/project', secureCookie);
    expect(res.status).toBe(200);
    expect(res.body.bindHost).toBe('127.0.0.1');
  });

  it('includes name and language in project response', async () => {
    const res = await request(securePort, 'GET', '/api/project', secureCookie);
    expect(res.body.name).toBe('secure-test');
  });
});
