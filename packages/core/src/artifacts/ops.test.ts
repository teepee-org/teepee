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
} from '../db/artifacts.js';
import {
  executeArtifactOps,
  readArtifactOpsFile,
  validateArtifactOps,
} from './ops.js';

let db: DatabaseType;
let outputDir: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-artifact-ops-test-'));
  outputDir = path.join(tmpDir, 'out');
  fs.mkdirSync(outputDir, { recursive: true });

  db = openDb(path.join(tmpDir, 'test.db'));
  runMigrations(db);
  db.exec(`INSERT INTO topics (name) VALUES ('topic-one')`);
});

describe('validateArtifactOps', () => {
  it('accepts valid read operations', () => {
    const { ops, errors } = validateArtifactOps({
      operations: [
        { op_id: 'r1', op: 'read-current', artifact_id: 1 },
        { op_id: 'r2', op: 'read-version', artifact_id: 1, version: 1 },
        { op_id: 'r3', op: 'read-diff', artifact_id: 1, from_version: 1, to_version: 'current', format: 'summary' },
      ],
    });

    expect(errors).toEqual([]);
    expect(ops).toHaveLength(3);
  });

  it('rejects duplicate op ids', () => {
    const { ops, errors } = validateArtifactOps({
      operations: [
        { op_id: 'dup', op: 'read-current', artifact_id: 1 },
        { op_id: 'dup', op: 'read-version', artifact_id: 1, version: 1 },
      ],
    });

    expect(ops).toBeNull();
    expect(errors[0].message).toContain('Duplicate op_id');
  });
});

describe('readArtifactOpsFile', () => {
  it('reads a valid artifact-ops file', () => {
    fs.writeFileSync(
      path.join(outputDir, 'artifact-ops.json'),
      JSON.stringify({ operations: [{ op_id: 'r1', op: 'read-current', artifact_id: 1 }] })
    );

    const { raw, error } = readArtifactOpsFile(outputDir);
    expect(error).toBeUndefined();
    expect(raw).toEqual({
      operations: [{ op_id: 'r1', op: 'read-current', artifact_id: 1 }],
    });
  });
});

describe('executeArtifactOps', () => {
  it('returns current body and tracks current-version reads', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'plan',
      title: 'Plan',
      body: 'v1 body',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2 body',
    });

    const result = executeArtifactOps(db, 1, [
      { op_id: 'r1', op: 'read-current', artifact_id: artifact.id },
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({
        op_id: 'r1',
        ok: true,
        op: 'read-current',
        version: 2,
        body: 'v2 body',
      }),
    ]);
    expect(result.accessState.currentVersionsRead[artifact.id]).toBe(2);
    expect(result.accessState.versionsRead[artifact.id]).toEqual([2]);
  });

  it('returns summary and unified diff data', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'report',
      title: 'Report',
      body: 'line 1\nline 2',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'line 1\nline 2 updated\nline 3',
    });

    const result = executeArtifactOps(db, 1, [
      {
        op_id: 'r2',
        op: 'read-diff',
        artifact_id: artifact.id,
        from_version: 1,
        to_version: 'current',
        format: 'unified',
      },
    ]);

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        op: 'read-diff',
        ok: true,
        from_version: 1,
        to_version: 2,
        format: 'unified',
        stats: {
          added_lines: 2,
          removed_lines: 1,
        },
      })
    );
    expect((result.results[0] as any).diff).toContain('--- v1');
    expect((result.results[0] as any).diff).toContain('+++ v2');
  });

  it('tracks historical versions read via read-version', () => {
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'report',
      title: 'Report',
      body: 'v1 body',
    });
    updateDocumentArtifact(db, {
      artifactId: artifact.id,
      baseVersion: 1,
      body: 'v2 body',
    });

    const result = executeArtifactOps(db, 1, [
      { op_id: 'r1', op: 'read-version', artifact_id: artifact.id, version: 1 },
      { op_id: 'r2', op: 'read-version', artifact_id: artifact.id, version: 'current' },
    ]);

    expect(result.accessState.versionsRead[artifact.id]).toEqual([1, 2]);
    expect(result.accessState.currentVersionsRead[artifact.id]).toBe(2);
  });

  it('allows reading artifacts inherited from parent topics', () => {
    db.exec(`
      INSERT INTO topics (id, name, parent_topic_id) VALUES (2, 'child-topic', 1);
    `);
    const { artifact } = createDocumentArtifact(db, {
      topicId: 1,
      kind: 'spec',
      title: 'Parent spec',
      body: 'parent body',
    });

    const result = executeArtifactOps(db, [2, 1], [
      { op_id: 'r1', op: 'read-current', artifact_id: artifact.id },
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({
        op_id: 'r1',
        ok: true,
        op: 'read-current',
        body: 'parent body',
      }),
    ]);
  });
});
