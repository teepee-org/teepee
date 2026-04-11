import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateManifest, readManifestFile, readArtifactFile } from './manifest.js';

let outputDir: string;

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-manifest-test-'));
  fs.mkdirSync(path.join(outputDir, 'files'), { recursive: true });
});

describe('validateManifest', () => {
  it('accepts valid create manifest', () => {
    const raw = {
      documents: [
        { op: 'create', kind: 'plan', title: 'My Plan', path: 'files/plan.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(errors).toEqual([]);
    expect(manifest!.documents.length).toBe(1);
    expect(manifest!.documents[0].op).toBe('create');
  });

  it('accepts valid update manifest', () => {
    const raw = {
      documents: [
        { op: 'update', artifact_id: 12, base_version: 3, path: 'files/spec.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(errors).toEqual([]);
    expect(manifest!.documents.length).toBe(1);
  });

  it('accepts symbolic current base_version in update manifest', () => {
    const raw = {
      documents: [
        { op: 'update', artifact_id: 12, base_version: 'current', path: 'files/spec.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(errors).toEqual([]);
    expect(manifest!.documents.length).toBe(1);
  });

  it('accepts valid restore manifest', () => {
    const raw = {
      documents: [
        { op: 'restore', artifact_id: 12, base_version: 3, restore_version: 1 },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(errors).toEqual([]);
    expect(manifest!.documents.length).toBe(1);
    expect(manifest!.documents[0].op).toBe('restore');
  });

  it('accepts valid rewrite-from-version manifest', () => {
    const raw = {
      documents: [
        { op: 'rewrite-from-version', artifact_id: 12, base_version: 3, source_version: 1, path: 'files/spec.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(errors).toEqual([]);
    expect(manifest!.documents.length).toBe(1);
    expect(manifest!.documents[0].op).toBe('rewrite-from-version');
  });

  it('rejects non-object manifest', () => {
    const { manifest, errors } = validateManifest('bad', outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('JSON object');
  });

  it('rejects missing documents array', () => {
    const { manifest, errors } = validateManifest({}, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('documents');
  });

  it('rejects absolute path', () => {
    const raw = {
      documents: [
        { op: 'create', kind: 'plan', title: 'Plan', path: '/etc/passwd' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('relative');
  });

  it('rejects path traversal', () => {
    const raw = {
      documents: [
        { op: 'create', kind: 'plan', title: 'Plan', path: 'files/../../../etc/passwd' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('traversal');
  });

  it('rejects path not under files/', () => {
    const raw = {
      documents: [
        { op: 'create', kind: 'plan', title: 'Plan', path: 'outside/plan.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('files/');
  });

  it('rejects invalid kind', () => {
    const raw = {
      documents: [
        { op: 'create', kind: 'hack', title: 'Plan', path: 'files/plan.md' },
      ],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('Invalid kind');
  });

  it('rejects extra keys at root level', () => {
    const raw = {
      documents: [{ op: 'create', kind: 'plan', title: 'Plan', path: 'files/plan.md' }],
      metadata: { author: 'test' },
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain("Unknown root key 'metadata'");
  });

  it('rejects extra keys in create entry', () => {
    const raw = {
      documents: [{ op: 'create', kind: 'plan', title: 'Plan', path: 'files/plan.md', format: 'html' }],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('Unknown keys');
    expect(errors[0].message).toContain('format');
  });

  it('rejects extra keys in update entry', () => {
    const raw = {
      documents: [{ op: 'update', artifact_id: 1, base_version: 1, path: 'files/spec.md', title: 'oops' }],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('Unknown keys');
  });

  it('rejects missing restore_version in restore entry', () => {
    const raw = {
      documents: [{ op: 'restore', artifact_id: 1, base_version: 1 }],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('restore_version');
  });

  it('rejects missing source_version in rewrite-from-version entry', () => {
    const raw = {
      documents: [{ op: 'rewrite-from-version', artifact_id: 1, base_version: 1, path: 'files/spec.md' }],
    };
    const { manifest, errors } = validateManifest(raw, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('source_version');
  });

  it('rejects too many files', () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      op: 'create',
      kind: 'plan',
      title: `Plan ${i}`,
      path: `files/plan${i}.md`,
    }));
    const { manifest, errors } = validateManifest({ documents: docs }, outputDir);
    expect(manifest).toBeNull();
    expect(errors[0].message).toContain('max file count');
  });
});

describe('readArtifactFile', () => {
  it('reads a valid file', () => {
    fs.writeFileSync(path.join(outputDir, 'files/plan.md'), '# Plan');
    const { body, error } = readArtifactFile(outputDir, 'files/plan.md');
    expect(error).toBeUndefined();
    expect(body).toBe('# Plan');
  });

  it('rejects symlinks', () => {
    const target = path.join(outputDir, 'real.md');
    const link = path.join(outputDir, 'files/link.md');
    fs.writeFileSync(target, 'data');
    fs.symlinkSync(target, link);
    const { error } = readArtifactFile(outputDir, 'files/link.md');
    expect(error).toContain('Symlinks');
  });

  it('rejects missing file', () => {
    const { error } = readArtifactFile(outputDir, 'files/missing.md');
    expect(error).toContain('not found');
  });

  it('rejects directory symlinks in path', () => {
    const realDir = path.join(outputDir, 'realdir');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'doc.md'), 'data');
    const linkDir = path.join(outputDir, 'files', 'linked');
    fs.symlinkSync(realDir, linkDir);
    const { error } = readArtifactFile(outputDir, 'files/linked/doc.md');
    expect(error).toContain('Symlinks not allowed in path');
  });

  it('rejects oversized file', () => {
    const bigFile = path.join(outputDir, 'files/big.md');
    fs.writeFileSync(bigFile, 'x'.repeat(600 * 1024));
    const { error } = readArtifactFile(outputDir, 'files/big.md');
    expect(error).toContain('exceeds max size');
  });
});

describe('readManifestFile', () => {
  it('returns null for missing file', () => {
    const { raw, error } = readManifestFile(outputDir);
    expect(raw).toBeNull();
    expect(error).toBeUndefined();
  });

  it('parses valid JSON', () => {
    fs.writeFileSync(path.join(outputDir, 'artifacts.json'), JSON.stringify({ documents: [] }));
    const { raw, error } = readManifestFile(outputDir);
    expect(error).toBeUndefined();
    expect(raw).toEqual({ documents: [] });
  });

  it('returns error for invalid JSON', () => {
    fs.writeFileSync(path.join(outputDir, 'artifacts.json'), 'not json');
    const { raw, error } = readManifestFile(outputDir);
    expect(raw).toBeNull();
    expect(error).toContain('Failed to parse');
  });
});
