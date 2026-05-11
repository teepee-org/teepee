import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSession, createUser, openDb } from 'teepee-core';
import { startServer } from './index.js';

interface RequestResult {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

function requestJson(
  port: number,
  method: string,
  urlPath: string,
  cookie?: string,
  body?: object
): Promise<RequestResult> {
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

function requestUpload(
  port: number,
  urlPath: string,
  cookie: string,
  payload: Buffer
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.length,
          Cookie: cookie,
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
    req.write(payload);
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

describe('filesystem write API (upload/mkdir)', () => {
  let tmpDir: string;
  let close: () => void;
  let port: number;
  let ownerCookie: string;
  let observerCookie: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-fs-write-'));
    fs.mkdirSync(path.join(tmpDir, '.teepee'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });

    const configPath = path.join(tmpDir, '.teepee', 'config.yaml');
    fs.writeFileSync(configPath, `
version: 2
mode: shared
teepee:
  name: fs-write-test
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
  observer:
    capabilities:
      - files.workspace.access
    agents: {}
`);

    port = 38000 + Math.floor(Math.random() * 4000);
    const result = startServer(configPath, port);
    close = result.close;
    await waitForServer(port);

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    ownerCookie = `teepee_session=${createSession(db, 'owner@localhost')}`;
    createUser(db, 'observer@example.test', 'observer');
    observerCookie = `teepee_session=${createSession(db, 'observer@example.test')}`;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('denies upload to non-owner users with 403', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=note.txt',
      observerCookie,
      Buffer.from('hello'),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(fs.existsSync(path.join(tmpDir, 'docs', 'note.txt'))).toBe(false);
  });

  it('uploads a file into a workspace subdirectory for owner', async () => {
    const payload = Buffer.from('hello upload\n');
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=note.txt',
      ownerCookie,
      payload,
    );
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe('docs/note.txt');
    expect(res.body.size).toBe(payload.length);

    const onDisk = fs.readFileSync(path.join(tmpDir, 'docs', 'note.txt'));
    expect(onDisk.equals(payload)).toBe(true);
  });

  it('uploads at the workspace root when path is "." or empty', async () => {
    const payload = Buffer.from('root level');
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=.&filename=root-note.txt',
      ownerCookie,
      payload,
    );
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('root-note.txt');
    expect(fs.readFileSync(path.join(tmpDir, 'root-note.txt'), 'utf-8')).toBe('root level');
  });

  it('rejects path-traversal filenames with 400', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=' + encodeURIComponent('../escape.txt'),
      ownerCookie,
      Buffer.from('nope'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
    expect(fs.existsSync(path.join(tmpDir, 'escape.txt'))).toBe(false);
  });

  it('rejects null-byte filenames with 400', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=' + encodeURIComponent('bad\u0000name.txt'),
      ownerCookie,
      Buffer.from('nope'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  it('rejects parent-path traversal via path query', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=' + encodeURIComponent('../') + '&filename=escape.txt',
      ownerCookie,
      Buffer.from('nope'),
    );
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(path.dirname(tmpDir), 'escape.txt'))).toBe(false);
  });

  it('returns 409 with suggestedName when file exists and on_conflict=fail', async () => {
    const target = path.join(tmpDir, 'docs', 'dup.txt');
    fs.writeFileSync(target, 'first');
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=dup.txt&on_conflict=fail',
      ownerCookie,
      Buffer.from('second'),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('File already exists');
    expect(res.body.suggestedName).toBe('dup (1).txt');
    expect(fs.readFileSync(target, 'utf-8')).toBe('first');
  });

  it('auto-renames when on_conflict=rename', async () => {
    const target = path.join(tmpDir, 'docs', 'rename-me.txt');
    fs.writeFileSync(target, 'original');
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=rename-me.txt&on_conflict=rename',
      ownerCookie,
      Buffer.from('new copy'),
    );
    expect(res.status).toBe(201);
    expect(res.body.renamed).toBe(true);
    expect(res.body.name).toBe('rename-me (1).txt');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original');
    expect(fs.readFileSync(path.join(tmpDir, 'docs', 'rename-me (1).txt'), 'utf-8')).toBe('new copy');
  });

  it('overwrites when on_conflict=overwrite', async () => {
    const target = path.join(tmpDir, 'docs', 'overwrite.txt');
    fs.writeFileSync(target, 'before');
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=overwrite.txt&on_conflict=overwrite',
      ownerCookie,
      Buffer.from('after'),
    );
    expect(res.status).toBe(201);
    expect(res.body.renamed).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('after');
  });

  it('rejects on_conflict overwrite when target is a directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'subdir'), { recursive: true });
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=subdir&on_conflict=overwrite',
      ownerCookie,
      Buffer.from('x'),
    );
    expect(res.status).toBe(409);
  });

  it('returns 413 when upload exceeds the size cap', async () => {
    const payload = Buffer.alloc(25 * 1024 * 1024 + 1, 0x41);
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=oversize.bin',
      ownerCookie,
      payload,
    );
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Payload too large');
    expect(fs.existsSync(path.join(tmpDir, 'docs', 'oversize.bin'))).toBe(false);
    const leftovers = fs.readdirSync(path.join(tmpDir, 'docs'))
      .filter((name) => name.startsWith('oversize.bin'));
    expect(leftovers).toEqual([]);
  });

  it('returns 400 when filename is missing', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs',
      ownerCookie,
      Buffer.from('x'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('filename is required');
  });

  it('returns 400 when on_conflict is invalid', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=docs&filename=ok.txt&on_conflict=wat',
      ownerCookie,
      Buffer.from('x'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when target directory does not exist', async () => {
    const res = await requestUpload(
      port,
      '/api/fs/upload?root=workspace&path=nope-nope&filename=x.txt',
      ownerCookie,
      Buffer.from('x'),
    );
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body.error).toBeTruthy();
  });

  // ── mkdir ──

  it('denies mkdir to non-owner users with 403', async () => {
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', observerCookie, {
      root: 'workspace', path: '.', name: 'new-folder',
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(tmpDir, 'new-folder'))).toBe(false);
  });

  it('creates a new directory inside a workspace subfolder', async () => {
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', ownerCookie, {
      root: 'workspace', path: 'docs', name: 'reports',
    });
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('docs/reports');
    expect(fs.statSync(path.join(tmpDir, 'docs', 'reports')).isDirectory()).toBe(true);
  });

  it('returns 409 when a directory with that name already exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'dup-dir'), { recursive: true });
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', ownerCookie, {
      root: 'workspace', path: 'docs', name: 'dup-dir',
    });
    expect(res.status).toBe(409);
  });

  it('rejects mkdir with traversal name', async () => {
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', ownerCookie, {
      root: 'workspace', path: 'docs', name: '../escape',
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(tmpDir, 'escape'))).toBe(false);
  });

  it('rejects mkdir with empty name', async () => {
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', ownerCookie, {
      root: 'workspace', path: 'docs', name: '',
    });
    expect(res.status).toBe(400);
  });

  it('rejects mkdir with missing root', async () => {
    const res = await requestJson(port, 'POST', '/api/fs/mkdir', ownerCookie, {
      path: 'docs', name: 'x',
    } as any);
    expect(res.status).toBe(400);
  });
});
