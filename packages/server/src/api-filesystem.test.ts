import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSession, createUser, openDb } from 'teepee-core';
import { startServer } from './index.js';

function request(
  port: number,
  method: string,
  urlPath: string,
  cookie?: string,
  body?: object
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
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

describe('filesystem access API', () => {
  let tmpDir: string;
  let hostRootDir: string;
  /** hostRootDir relative to / (no leading slash) */
  let hostRelDir: string;
  let close: () => void;
  let port: number;
  let ownerCookie: string;
  let adminCookie: string;
  let observerCookie: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-fs-api-'));
    hostRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-fs-host-'));
    fs.mkdirSync(path.join(tmpDir, '.teepee'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# workspace\n');
    fs.writeFileSync(path.join(hostRootDir, 'outside.txt'), 'outside root\n');
    fs.mkdirSync(path.join(hostRootDir, 'etc'), { recursive: true });
    fs.writeFileSync(path.join(hostRootDir, 'etc', 'hosts'), '127.0.0.1 localhost\n');

    const configPath = path.join(tmpDir, '.teepee', 'config.yaml');
    // host root is always / — test files live under hostRootDir which is an absolute path
    hostRelDir = hostRootDir.replace(/^\//, '');
    fs.writeFileSync(configPath, `
version: 2
mode: shared
teepee:
  name: fs-api-test
providers:
  echo:
    command: "cat"
agents:
  architect:
    provider: echo
roles:
  owner:
    superuser: true
    agents:
      architect: trusted
  admin:
    capabilities:
      - files.workspace.access
      - files.host.access
      - messages.post
    agents: {}
  observer:
    capabilities:
      - files.workspace.access
    agents: {}
`);

    port = 33000 + Math.floor(Math.random() * 5000);
    const result = startServer(configPath, port);
    close = result.close;
    await waitForServer(port);

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    ownerCookie = `teepee_session=${createSession(db, 'owner@localhost')}`;
    createUser(db, 'admin@example.test', 'admin');
    createUser(db, 'observer@example.test', 'observer');
    adminCookie = `teepee_session=${createSession(db, 'admin@example.test')}`;
    observerCookie = `teepee_session=${createSession(db, 'observer@example.test')}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostRootDir, { recursive: true, force: true });
  });

  it('exposes accessible roots in the session payload', async () => {
    const res = await request(port, 'GET', '/auth/session', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.fileRoots).toEqual([
      { id: 'workspace', kind: 'workspace', path: '.' },
      { id: 'host', kind: 'host', path: '/' },
    ]);
  });

  it('keeps workspace previews available to read-only users with workspace capability', async () => {
    const res = await request(port, 'GET', '/api/workspace/file?path=README.md', observerCookie);
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('# workspace');
  });

  it('lists entries inside authorized roots', async () => {
    const res = await request(port, 'GET', `/api/fs/entries?root=host&path=${encodeURIComponent(hostRelDir)}`, adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { name: 'etc', path: `${hostRelDir}/etc`, type: 'directory' },
      { name: 'outside.txt', path: `${hostRelDir}/outside.txt`, type: 'file' },
    ]);
  });

  it('denies host root access without files.host.access', async () => {
    const res = await request(port, 'GET', `/api/fs/file?root=host&path=${encodeURIComponent(hostRelDir + '/outside.txt')}`, observerCookie);
    expect(res.status).toBe(403);
  });

  it('allows host root preview and reference resolution when explicitly authorized', async () => {
    const preview = await request(port, 'GET', `/api/fs/file?root=host&path=${encodeURIComponent(hostRelDir + '/outside.txt')}`, adminCookie);
    expect(preview.status).toBe(200);
    expect(preview.body.content).toContain('outside root');

    const hostFilePath = `${hostRelDir}/outside.txt`;
    const resolved = await request(
      port,
      'POST',
      '/api/references/resolve',
      adminCookie,
      { href: `teepee:/fs/host/${hostFilePath}` }
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.fetch).toEqual({ kind: 'filesystem', rootId: 'host', path: hostFilePath });
  });

  it('previews extensionless host text files as text content', async () => {
    const preview = await request(port, 'GET', `/api/fs/file?root=host&path=${encodeURIComponent(hostRelDir + '/etc/hosts')}`, ownerCookie);
    expect(preview.status).toBe(200);
    expect(preview.body.mime).toBe('text/plain');
    expect(preview.body.content).toContain('127.0.0.1 localhost');
  });

  it('returns host-root suggestions only to authorized roles', async () => {
    const denied = await request(port, 'GET', `/api/references/suggest?q=${encodeURIComponent(hostRelDir + '/outside')}&limit=5`, observerCookie);
    expect(denied.status).toBe(200);
    expect(denied.body.items.some((item: any) => item.type === 'filesystem_file')).toBe(false);

    const allowed = await request(port, 'GET', `/api/references/suggest?q=${encodeURIComponent(hostRelDir + '/outside')}&limit=5`, adminCookie);
    expect(allowed.status).toBe(200);
    expect(allowed.body.items.some((item: any) => item.canonicalUri === `teepee:/fs/host/${hostRelDir}/outside.txt`)).toBe(true);
  });

  it('lets owner resolve host-root files with absolute-style path queries', async () => {
    const res = await request(port, 'GET', `/api/references/suggest?q=${encodeURIComponent(hostRootDir + '/outside')}&limit=5`, ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.items.some((item: any) => item.canonicalUri === `teepee:/fs/host/${hostRelDir}/outside.txt`)).toBe(true);
  });

  it('suggests host directories for partial absolute path prefixes', async () => {
    const res = await request(port, 'GET', `/api/references/suggest?q=${encodeURIComponent(hostRootDir + '/et')}&limit=5`, ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'filesystem_dir',
          canonicalUri: `teepee:/fs/host/${hostRelDir}/etc/`,
          insertText: `[[${hostRootDir}/etc/`,
          continueAutocomplete: true,
        }),
      ])
    );
  });

  it('lists files inside host directories when the query targets a directory path', async () => {
    const res = await request(port, 'GET', `/api/references/suggest?q=${encodeURIComponent(hostRootDir + '/etc/')}&limit=5`, ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.items.some((item: any) => item.canonicalUri === `teepee:/fs/host/${hostRelDir}/etc/hosts`)).toBe(true);
  });
});
