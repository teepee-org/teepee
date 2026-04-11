import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  createDocumentArtifact,
  createSession,
  createUser,
  getArtifact,
  openDb,
} from 'teepee-core';
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

function writeConfig(dir: string) {
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const configPath = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(configPath, `
version: 1
mode: shared
teepee:
  name: artifact-api-test
providers:
  echo:
    command: "cat"
agents:
  architect:
    provider: echo
`);
  return configPath;
}

describe('artifact API routes', () => {
  let close: () => void;
  let port: number;
  let tmpDir: string;
  let ownerCookie: string;
  let collaboratorCookie: string;
  let observerCookie: string;
  let artifactId: number;
  let versionId: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-artifact-api-'));
    execFileSync('git', ['init'], { cwd: tmpDir, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: tmpDir, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, encoding: 'utf-8' });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'rollout-notes.md'), '# Rollout notes\n');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'sample.pdf'), Buffer.from('%PDF-1.4\n%', 'utf-8'));

    const config = writeConfig(tmpDir);
    port = 36000 + Math.floor(Math.random() * 5000);
    const result = startServer(config, port);
    close = result.close;
    await waitForServer(port);

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    createUser(db, 'collab@example.test', 'collaborator');
    createUser(db, 'observer@example.test', 'observer');
    ownerCookie = `teepee_session=${createSession(db, 'owner@localhost')}`;
    collaboratorCookie = `teepee_session=${createSession(db, 'collab@example.test')}`;
    observerCookie = `teepee_session=${createSession(db, 'observer@example.test')}`;
    db.exec(`
      INSERT INTO topics (name) VALUES ('Artifacts');
      INSERT INTO messages (topic_id, author_type, author_name, body) VALUES (1, 'agent', 'architect', 'response');
      INSERT INTO invocation_batches (trigger_message_id) VALUES (1);
      INSERT INTO jobs (batch_id, agent_name) VALUES (1, 'architect');
    `);
    const created = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Queue UI rollout',
      body: '# Queue UI rollout',
      createdByAgent: 'architect',
      createdByJobId: 1,
      createdFromMessageId: 1,
    });
    artifactId = created.artifact.id;
    versionId = created.version.id;
    db.close();
  });

  afterAll(() => {
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets authenticated non-owners read artifacts and download markdown', async () => {
    const list = await request(port, 'GET', '/api/topics/1/artifacts', observerCookie);
    expect(list.status).toBe(200);
    expect(list.body[0].title).toBe('Queue UI rollout');

    const versions = await request(port, 'GET', `/api/artifacts/${artifactId}/versions`, collaboratorCookie);
    expect(versions.status).toBe(200);
    expect(versions.body.map((v: any) => v.version)).toEqual([1]);

    const download = await request(port, 'GET', `/api/artifacts/${artifactId}/versions/${versionId}/download`, observerCookie);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/markdown');
    expect(download.body).toBe('# Queue UI rollout');
  });

  it('keeps promote owner-only and records repo metadata on success', async () => {
    const denied = await request(
      port,
      'POST',
      `/api/artifacts/${artifactId}/versions/${versionId}/promote`,
      collaboratorCookie,
      { repoPath: 'docs/queue-ui-rollout.md' }
    );
    expect(denied.status).toBe(403);

    const promoted = await request(
      port,
      'POST',
      `/api/artifacts/${artifactId}/versions/${versionId}/promote`,
      ownerCookie,
      { repoPath: 'docs/queue-ui-rollout.md' }
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'docs/queue-ui-rollout.md'), 'utf-8')).toBe('# Queue UI rollout');

    const db = openDb(path.join(tmpDir, '.teepee', 'db.sqlite'));
    const artifact = getArtifact(db, artifactId)!;
    db.close();
    expect(artifact.canonical_source).toBe('repo');
    expect(artifact.promoted_repo_path).toBe('docs/queue-ui-rollout.md');
    expect(artifact.promoted_commit_sha).toBe(promoted.body.commitSha);
  });

  it('rejects artifact versioned references when the requested version does not exist', async () => {
    const resolved = await request(
      port,
      'POST',
      '/api/references/resolve',
      collaboratorCookie,
      { href: `teepee:/artifact/${artifactId}#v999` }
    );

    expect(resolved.status).toBe(404);
    expect(resolved.body.error).toContain('v999');
  });

  it('serves inline-safe workspace previews for browser-previewable files', async () => {
    const preview = await request(
      port,
      'GET',
      '/api/workspace/download?path=assets%2Fsample.pdf&disposition=inline',
      observerCookie
    );

    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    expect(preview.headers['content-disposition']).toContain('inline;');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
  });

  it('ranks reference suggestions with a single cross-namespace score', async () => {
    const global = await request(
      port,
      'GET',
      '/api/references/suggest?q=roll&limit=5',
      observerCookie
    );
    expect(global.status).toBe(200);
    expect(global.body.items[0].type).toBe('workspace_file');

    const topicScoped = await request(
      port,
      'GET',
      '/api/references/suggest?q=queue&topicId=1&limit=5',
      observerCookie
    );
    expect(topicScoped.status).toBe(200);
    expect(topicScoped.body.items[0].type).toBe('artifact_document');
    expect(topicScoped.body.items[0].canonicalUri).toBe(`teepee:/artifact/${artifactId}`);
  });
});
