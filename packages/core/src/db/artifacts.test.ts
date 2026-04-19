import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from './database.js';
import { SCHEMA } from './schema.js';
import { runMigrations } from './migrate.js';
import {
  createDocumentArtifact,
  updateDocumentArtifact,
  listTopicArtifacts,
  getArtifact,
  getArtifactVersions,
  getArtifactVersion,
  getCurrentArtifactVersion,
  linkMessageArtifact,
  getMessageArtifacts,
  getEnrichedMessageArtifacts,
  listTopicArtifactContext,
  promoteArtifact,
  restoreDocumentArtifact,
  rewriteDocumentArtifactFromVersion,
  ArtifactConflictError,
} from './artifacts.js';
import type { Database as DatabaseType } from 'better-sqlite3';

let db: DatabaseType;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-art-test-'));
  db = openDb(path.join(tmpDir, 'test.db'));
  runMigrations(db);
  db.exec("INSERT INTO topics (name) VALUES ('test-topic')");
  db.exec("INSERT INTO messages (topic_id, author_type, author_name, body) VALUES (1, 'user', 'alice', 'hello')");
  db.exec("INSERT INTO invocation_batches (trigger_message_id) VALUES (1)");
  db.exec("INSERT INTO jobs (batch_id, agent_name) VALUES (1, 'architect')");
});

describe('createDocumentArtifact', () => {
  it('creates an artifact with version 1', () => {
    const { artifact, version } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Test Plan',
      body: '# Plan\n\nHello',
      createdByAgent: 'architect',
      createdByJobId: 1,
    });

    expect(artifact.id).toBe(1);
    expect(artifact.artifact_class).toBe('document');
    expect(artifact.kind).toBe('plan');
    expect(artifact.title).toBe('Test Plan');
    expect(artifact.status).toBe('draft');
    expect(artifact.current_version_id).toBe(version.id);

    expect(version.version).toBe(1);
    expect(version.content_type).toBe('text/markdown');
    expect(version.body).toBe('# Plan\n\nHello');
  });
});

describe('updateDocumentArtifact', () => {
  it('creates version 2 on update', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Spec',
      body: 'v1 body',
    });

    const { version: v2 } = updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2 body',
    });

    expect(v2.version).toBe(2);
    expect(v2.body).toBe('v2 body');
  });

  it('throws ArtifactConflictError on wrong base_version', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Spec',
      body: 'v1 body',
    });

    expect(() => {
      updateDocumentArtifact(db, {
        artifactId: artifact.id,
        baseVersion: 0,
        body: 'conflict body',
      });
    }).toThrow(ArtifactConflictError);
  });

  it('restores an older version as a new head version', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Spec',
      body: 'v1 body',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2 body',
    });

    const { version: restored } = restoreDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 2,
      restoreVersion: 1,
    });

    expect(restored.version).toBe(3);
    expect(restored.body).toBe('v1 body');
    expect(getCurrentArtifactVersion(db, artifact.id)?.version).toBe(3);
  });

  it('rewrites from an older version into a new head version', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Spec',
      body: 'v1 body',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2 body',
    });

    const { version: rewritten } = rewriteDocumentArtifactFromVersion(db, {
      artifactId: artifact.id,
      baseVersion: 2,
      sourceVersion: 1,
      body: 'v1 body\n\n## Sicurezza\n\nContenuto nuovo.',
    });

    expect(rewritten.version).toBe(3);
    expect(rewritten.body).toContain('## Sicurezza');
    expect(rewritten.body).toContain('v1 body');
    expect(getCurrentArtifactVersion(db, artifact.id)?.version).toBe(3);
  });
});

describe('listTopicArtifacts', () => {
  it('lists artifacts for a topic', () => {
    createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'A', body: 'a' });
    createDocumentArtifact(db, { topicId: 1, kind: 'spec', title: 'B', body: 'b' });

    const artifacts = listTopicArtifacts(db, 1);
    expect(artifacts.length).toBe(2);
    expect(artifacts[0].title).toBe('A');
    expect(artifacts[1].title).toBe('B');
  });
});

describe('getArtifactVersions', () => {
  it('lists all versions', () => {
    const { artifact } = createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'A', body: 'v1' });
    updateDocumentArtifact(db, { artifactId: artifact.id, baseVersion: 1, body: 'v2' });
    updateDocumentArtifact(db, { artifactId: artifact.id, baseVersion: 2, body: 'v3' });

    const versions = getArtifactVersions(db, artifact.id);
    expect(versions.length).toBe(3);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });
});

describe('linkMessageArtifact', () => {
  it('links and retrieves message artifacts', () => {
    const { artifact, version } = createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'A', body: 'body' });
    linkMessageArtifact(db, 1, artifact.id, version.id, 'created');

    const links = getMessageArtifacts(db, 1);
    expect(links.length).toBe(1);
    expect(links[0].relation).toBe('created');

    const enriched = getEnrichedMessageArtifacts(db, 1);
    expect(enriched.length).toBe(1);
    expect(enriched[0].kind).toBe('plan');
    expect(enriched[0].title).toBe('A');
    expect(enriched[0].version).toBe(1);
  });
});

describe('listTopicArtifactContext', () => {
  it('returns context info with version number', () => {
    const { artifact } = createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'Plan', body: 'v1' });
    updateDocumentArtifact(db, { artifactId: artifact.id, baseVersion: 1, body: 'v2' });

    const ctx = listTopicArtifactContext(db, 1);
    expect(ctx.length).toBe(1);
    expect(ctx[0].current_version).toBe(2);
    expect(ctx[0].kind).toBe('plan');
  });
});

describe('promoteArtifact', () => {
  it('defaults promoted_commit_sha to null when no sha is provided', () => {
    const { artifact } = createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'Plan', body: 'body' });
    promoteArtifact(db, artifact.id, 'docs/plan.md');

    const updated = getArtifact(db, artifact.id)!;
    expect(updated.canonical_source).toBe('repo');
    expect(updated.promoted_repo_path).toBe('docs/plan.md');
    expect(updated.promoted_commit_sha).toBeNull();
  });

  it('records promoted_commit_sha when provided', () => {
    const { artifact } = createDocumentArtifact(db, { topicId: 1, kind: 'plan', title: 'Plan', body: 'body' });
    promoteArtifact(db, artifact.id, 'docs/plan.md', 'abc123');

    const updated = getArtifact(db, artifact.id)!;
    expect(updated.promoted_commit_sha).toBe('abc123');
  });
});
