import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openDb } from '../db/database.js';
import { runMigrations } from '../db/migrate.js';
import {
  createDocumentArtifact,
  updateDocumentArtifact,
  getArtifactVersions,
  getMessageArtifacts,
  listTopicArtifacts,
} from '../db/artifacts.js';
import { applyArtifactEdits, formatIngestSummary, ingestArtifacts } from './ingest.js';

let db: DatabaseType;
let outputDir: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-ingest-test-'));
  outputDir = path.join(tmpDir, 'out');
  fs.mkdirSync(path.join(outputDir, 'files'), { recursive: true });

  db = openDb(path.join(tmpDir, 'test.db'));
  runMigrations(db);
  db.exec(`
    INSERT INTO topics (name) VALUES ('topic-one');
    INSERT INTO topics (name) VALUES ('topic-two');
    INSERT INTO messages (topic_id, author_type, author_name, body) VALUES (1, 'agent', 'architect', 'response');
    INSERT INTO invocation_batches (trigger_message_id) VALUES (1);
    INSERT INTO jobs (batch_id, agent_name) VALUES (1, 'architect');
  `);
});

function writeManifest(documents: unknown[]) {
  fs.writeFileSync(
    path.join(outputDir, 'artifacts.json'),
    JSON.stringify({ documents })
  );
}

function ingest() {
  return ingestArtifacts(db, {
    outputDir,
    topicId: 1,
    messageId: 1,
    jobId: 1,
    agentName: 'architect',
    userEmail: 'alice@example.test',
  });
}

describe('ingestArtifacts', () => {
  it('blocks update when current head was not read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Plan',
      body: 'v1',
    });
    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Updated plan');
    writeManifest([
      { op: 'update', artifact_id: artifact.id, base_version: 1, path: 'files/plan.md' },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: { currentVersionsRead: {}, versionsRead: {} },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('requires read-current');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1]);
  });

  it('updates using symbolic current base_version after reading the current head', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Plan',
      body: 'v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2',
    });

    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Updated plan');
    writeManifest([
      { op: 'update', artifact_id: artifact.id, base_version: 'current', path: 'files/plan.md' },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 2 },
        versionsRead: { [artifact.id]: [2] },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.imported[0].op).toBe('update');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.body)).toEqual(['v1', 'v2', '# Updated plan']);
  });

  it('restores a previous version when current head was read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'report',
      title: 'Report',
      body: 'v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2',
    });

    writeManifest([
      { op: 'restore', artifact_id: artifact.id, base_version: 2, restore_version: 1 },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: { currentVersionsRead: { [artifact.id]: 2 }, versionsRead: { [artifact.id]: [2] } },
    });

    expect(result.skipped).toBe(false);
    expect(result.imported[0].op).toBe('restore');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.body)).toEqual(['v1', 'v2', 'v1']);
  });

  it('rewrites from a historical version only when both head and source were read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'report',
      title: 'Report',
      body: 'v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2',
    });

    fs.writeFileSync(path.join(outputDir, 'files/report.md'), 'v1\n\n## Sicurezza\n\nNuovo paragrafo.');
    writeManifest([
      { op: 'rewrite-from-version', artifact_id: artifact.id, base_version: 2, source_version: 1, path: 'files/report.md' },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 2 },
        versionsRead: { [artifact.id]: [1, 2] },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.imported[0].op).toBe('rewrite-from-version');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.body)).toEqual(['v1', 'v2', 'v1\n\n## Sicurezza\n\nNuovo paragrafo.']);
    expect(getMessageArtifacts(db, 1)[0].relation).toBe('rewritten');
  });

  it('blocks rewrite-from-version when source version was not read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'report',
      title: 'Report',
      body: 'v1',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2',
    });

    fs.writeFileSync(path.join(outputDir, 'files/report.md'), 'v1\n\n## Sicurezza\n\nNuovo paragrafo.');
    writeManifest([
      { op: 'rewrite-from-version', artifact_id: artifact.id, base_version: 2, source_version: 1, path: 'files/report.md' },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 2 },
        versionsRead: { [artifact.id]: [2] },
      },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('rewrite-from-version requires read-version');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1, 2]);
  });

  it('blocks symbolic current base_version when current head was not read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Plan',
      body: 'v1',
    });

    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Updated plan');
    writeManifest([
      { op: 'update', artifact_id: artifact.id, base_version: 'current', path: 'files/plan.md' },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: { currentVersionsRead: {}, versionsRead: {} },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('base_version is "current"');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1]);
  });

  it('does not partially import when a later manifest file is invalid', () => {
    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Plan');
    writeManifest([
      { op: 'create', kind: 'plan', title: 'Plan', path: 'files/plan.md' },
      { op: 'create', kind: 'spec', title: 'Missing', path: 'files/missing.md' },
    ]);

    const result = ingest();

    expect(result.skipped).toBe(true);
    expect(result.imported).toEqual([]);
    expect(result.errors[0]).toContain('File not found');
    expect(listTopicArtifacts(db, 1)).toEqual([]);
    expect(getMessageArtifacts(db, 1)).toEqual([]);
  });

  it('rolls back all writes when an update targets an artifact from another topic', () => {
    const { artifact: otherTopicArtifact } = createDocumentArtifact(db, {
      topicId: 2,
      kind: 'spec',
      title: 'Other topic spec',
      body: 'v1',
    });
    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Plan');
    fs.writeFileSync(path.join(outputDir, 'files/spec.md'), '# Spec');
    writeManifest([
      { op: 'create', kind: 'plan', title: 'Plan', path: 'files/plan.md' },
      { op: 'update', artifact_id: otherTopicArtifact.id, base_version: 1, path: 'files/spec.md' },
    ]);

    const result = ingest();

    expect(result.skipped).toBe(true);
    expect(result.imported).toEqual([]);
    expect(result.errors[0]).toContain(`Artifact ${otherTopicArtifact.id} does not belong to topic 1`);
    expect(listTopicArtifacts(db, 1)).toEqual([]);
    expect(getArtifactVersions(db, otherTopicArtifact.id).map((v) => v.version)).toEqual([1]);
    expect(getMessageArtifacts(db, 1)).toEqual([]);
  });

  it('applies a single-edit op against the current head body', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'KB Mode',
      body: '# KB\n\n## Riferimenti\n\nEnd.',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [
          {
            find: '## Riferimenti\n\n',
            replace: '## Riferimenti\n\n- [Karpathy gist](https://example.test/g)\n',
          },
        ],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 1 },
        versionsRead: { [artifact.id]: [1] },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual([]);
    const versions = getArtifactVersions(db, artifact.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1].body).toBe(
      '# KB\n\n## Riferimenti\n\n- [Karpathy gist](https://example.test/g)\nEnd.'
    );
  });

  it('rejects edit whose find string is not present', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Doc',
      body: 'Hello world',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [{ find: 'missing', replace: 'x' }],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 1 },
        versionsRead: { [artifact.id]: [1] },
      },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('edit 0');
    expect(result.errors[0]).toContain('not found');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1]);
  });

  it('rejects edit when find is ambiguous without replace_all', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Doc',
      body: 'foo foo foo',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [{ find: 'foo', replace: 'bar' }],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 1 },
        versionsRead: { [artifact.id]: [1] },
      },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('matches 3 places');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1]);
  });

  it('supports replace_all to rewrite every occurrence', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Doc',
      body: 'old old old',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [{ find: 'old', replace: 'new', replace_all: true }],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 1 },
        versionsRead: { [artifact.id]: [1] },
      },
    });

    expect(result.skipped).toBe(false);
    const versions = getArtifactVersions(db, artifact.id);
    expect(versions[1].body).toBe('new new new');
  });

  it('applies multiple edits sequentially in order', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Doc',
      body: 'a\nb\nc\n',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [
          { find: 'a\n', replace: 'A\n' },
          { find: 'b\n', replace: 'B\n' },
        ],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: {
        currentVersionsRead: { [artifact.id]: 1 },
        versionsRead: { [artifact.id]: [1] },
      },
    });

    expect(result.skipped).toBe(false);
    const versions = getArtifactVersions(db, artifact.id);
    expect(versions[1].body).toBe('A\nB\nc\n');
  });

  it('blocks edit when current head was not read first', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Doc',
      body: 'foo',
    });
    writeManifest([
      {
        op: 'edit',
        artifact_id: artifact.id,
        base_version: 'current',
        edits: [{ find: 'foo', replace: 'bar' }],
      },
    ]);

    const result = ingestArtifacts(db, {
      outputDir,
      topicId: 1,
      messageId: 1,
      jobId: 1,
      agentName: 'architect',
      userEmail: 'alice@example.test',
      enforceCurrentRead: true,
      artifactReadAccess: { currentVersionsRead: {}, versionsRead: {} },
    });

    expect(result.skipped).toBe(true);
    expect(result.errors[0]).toContain('requires read-current');
    expect(getArtifactVersions(db, artifact.id).map((v) => v.version)).toEqual([1]);
  });
});

describe('formatIngestSummary', () => {
  const baseArtifact = { id: 1, topic_id: 1, kind: 'spec', title: 'Doc', summary: null, current_version_id: 1, created_at: '', updated_at: '', deleted_at: null } as any;
  const baseVersion = { id: 1, artifact_id: 1, version: 1, content_type: 'markdown', body: '', summary: null, created_by_agent: null, created_by_user_id: null, created_by_user_email: null, created_by_job_id: null, source_message_id: null, created_at: '' } as any;

  it('returns null on empty imported list', () => {
    expect(formatIngestSummary([])).toBeNull();
  });

  it('formats a single create line', () => {
    const out = formatIngestSummary([
      { artifact: { ...baseArtifact, title: 'Plan A' }, version: { ...baseVersion, version: 1 }, op: 'create' },
    ]);
    expect(out).toBe('📄 artifact "Plan A" → v1 (created)');
  });

  it('formats a single update line', () => {
    const out = formatIngestSummary([
      { artifact: { ...baseArtifact, title: 'KB Mode' }, version: { ...baseVersion, version: 5 }, op: 'update' },
    ]);
    expect(out).toBe('📄 artifact "KB Mode" → v5 (updated)');
  });

  it('formats restore and rewrite-from-version distinctly', () => {
    const out = formatIngestSummary([
      { artifact: { ...baseArtifact, title: 'R' }, version: { ...baseVersion, version: 4 }, op: 'restore' },
      { artifact: { ...baseArtifact, title: 'W' }, version: { ...baseVersion, version: 3 }, op: 'rewrite-from-version' },
    ]);
    expect(out).toBe('📄 artifact "R" → v4 (restored)\n📄 artifact "W" → v3 (rewritten)');
  });

  it('concatenates multiple artifacts one per line', () => {
    const out = formatIngestSummary([
      { artifact: { ...baseArtifact, title: 'A' }, version: { ...baseVersion, version: 1 }, op: 'create' },
      { artifact: { ...baseArtifact, title: 'B' }, version: { ...baseVersion, version: 2 }, op: 'update' },
    ]);
    expect(out!.split('\n').length).toBe(2);
  });
});

describe('applyArtifactEdits', () => {
  it('returns the unchanged body for an empty (but invariant not reached via validator) scenario safely', () => {
    // Validator disallows empty edits, but the pure function should still handle edits of length 0
    const result = applyArtifactEdits('hello', []);
    expect(result).toEqual({ body: 'hello' });
  });

  it('applies one edit', () => {
    const result = applyArtifactEdits('hello world', [{ find: 'world', replace: 'teepee' }]);
    expect(result).toEqual({ body: 'hello teepee' });
  });

  it('reports not-found with edit index', () => {
    const result = applyArtifactEdits('hello', [
      { find: 'hello', replace: 'hi' },
      { find: 'missing', replace: 'x' },
    ]);
    expect(result).toEqual({ error: `'find' string not found in artifact body`, editIndex: 1 });
  });

  it('reports ambiguity with count and edit index', () => {
    const result = applyArtifactEdits('a a a', [{ find: 'a', replace: 'b' }]);
    expect('error' in result && result.error.includes('matches 3 places')).toBe(true);
    expect('editIndex' in result && result.editIndex === 0).toBe(true);
  });
});
