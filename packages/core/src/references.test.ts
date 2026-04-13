import { describe, it, expect } from 'vitest';
import {
  parseTeepeeUri,
  normalizeLegacyHref,
  resolveReference,
  detectPreviewMimeLanguage,
  isLikelyTextBuffer,
} from './references';

describe('parseTeepeeUri', () => {
  it('parses workspace URI', () => {
    const r = parseTeepeeUri('teepee:/workspace/packages/core/src/db/schema.ts');
    expect(r).toEqual({
      namespace: 'workspace',
      resource: 'packages/core/src/db/schema.ts',
      line: undefined,
      column: undefined,
    });
  });

  it('parses workspace URI with line', () => {
    const r = parseTeepeeUri('teepee:/workspace/src/index.ts#L42');
    expect(r).toEqual({
      namespace: 'workspace',
      resource: 'src/index.ts',
      line: 42,
      column: undefined,
    });
  });

  it('parses workspace URI with line and column', () => {
    const r = parseTeepeeUri('teepee:/workspace/src/index.ts#L42C10');
    expect(r).toEqual({
      namespace: 'workspace',
      resource: 'src/index.ts',
      line: 42,
      column: 10,
    });
  });

  it('parses artifact URI without version', () => {
    const r = parseTeepeeUri('teepee:/artifact/3');
    expect(r).toEqual({
      namespace: 'artifact',
      resource: '3',
      artifactVersion: undefined,
      treePath: undefined,
    });
  });

  it('parses artifact URI with version', () => {
    const r = parseTeepeeUri('teepee:/artifact/3#v2');
    expect(r).toEqual({
      namespace: 'artifact',
      resource: '3',
      artifactVersion: 2,
      treePath: undefined,
    });
  });

  it('parses future filetree URI', () => {
    const r = parseTeepeeUri('teepee:/artifact/12#v4/path/src/index.ts');
    expect(r).toEqual({
      namespace: 'artifact',
      resource: '12',
      artifactVersion: 4,
      treePath: 'src/index.ts',
    });
  });

  it('rejects path traversal', () => {
    expect(parseTeepeeUri('teepee:/workspace/../etc/passwd')).toBeNull();
  });

  it('rejects leading slash in workspace', () => {
    expect(parseTeepeeUri('teepee:/workspace//etc/passwd')).toBeNull();
  });

  it('rejects non-teepee URIs', () => {
    expect(parseTeepeeUri('https://example.com')).toBeNull();
  });

  it('parses filesystem URI with root id', () => {
    const r = parseTeepeeUri('teepee:/fs/host/etc/hosts#L3');
    expect(r).toEqual({
      namespace: 'fs',
      rootId: 'host',
      resource: 'etc/hosts',
      line: 3,
      column: undefined,
    });
  });
});

describe('normalizeLegacyHref', () => {
  const base = '/home/user/project';

  it('normalizes absolute path under project', () => {
    expect(normalizeLegacyHref('/home/user/project/src/index.ts', base))
      .toBe('teepee:/workspace/src/index.ts');
  });

  it('normalizes path with line number', () => {
    expect(normalizeLegacyHref('/home/user/project/src/index.ts:42', base))
      .toBe('teepee:/workspace/src/index.ts#L42');
  });

  it('rejects path outside project', () => {
    expect(normalizeLegacyHref('/home/user/other/file.ts', base)).toBeNull();
  });

  it('rejects file:// protocol', () => {
    expect(normalizeLegacyHref('file:///home/user/project/file.ts', base)).toBeNull();
  });

  it('rejects relative paths', () => {
    expect(normalizeLegacyHref('src/index.ts', base)).toBeNull();
  });

  it('passes through teepee:/ URIs', () => {
    expect(normalizeLegacyHref('teepee:/workspace/x.ts', base))
      .toBe('teepee:/workspace/x.ts');
  });

  it('rejects traversal in normalized path', () => {
    expect(normalizeLegacyHref('/home/user/project/../project/file.ts', base)).toBeNull();
  });

  it('normalizes absolute paths under configured host roots', () => {
    expect(
      normalizeLegacyHref('/etc/hosts', base, [{ id: 'host', kind: 'host', path: '/', resolvedPath: '/' }])
    ).toBe('teepee:/fs/host/etc/hosts');
  });
});

describe('resolveReference', () => {
  const base = '/home/frapas/dx-lang/dx-04/teepee';

  it('resolves workspace file', () => {
    const r = resolveReference('teepee:/workspace/packages/core/src/index.ts', base);
    expect(r).not.toBeNull();
    expect(r!.targetType).toBe('workspace-file');
    expect(r!.language).toBe('typescript');
    expect(r!.fetch).toEqual({ kind: 'workspace', path: 'packages/core/src/index.ts' });
  });

  it('resolves artifact document', () => {
    const r = resolveReference('teepee:/artifact/5', base);
    expect(r).not.toBeNull();
    expect(r!.targetType).toBe('artifact-document');
    expect(r!.fetch).toEqual({ kind: 'artifact-document', artifactId: 5, version: undefined });
  });

  it('resolves artifact with version', () => {
    const r = resolveReference('teepee:/artifact/5#v2', base);
    expect(r).not.toBeNull();
    expect(r!.fetch).toEqual({ kind: 'artifact-document', artifactId: 5, version: 2 });
  });

  it('returns null for invalid URIs', () => {
    expect(resolveReference('https://example.com', base)).toBeNull();
  });

  it('resolves filesystem file references for configured roots', () => {
    const r = resolveReference(
      'teepee:/fs/host/etc/hosts',
      base,
      [{ id: 'host', kind: 'host', path: '/', resolvedPath: '/' }]
    );
    expect(r).not.toBeNull();
    expect(r!.targetType).toBe('filesystem-file');
    expect(r!.fetch).toEqual({ kind: 'filesystem', rootId: 'host', path: 'etc/hosts' });
  });
});

describe('detectPreviewMimeLanguage', () => {
  it('treats extensionless utf8 files as text/plain for preview', () => {
    expect(isLikelyTextBuffer(Buffer.from('127.0.0.1 localhost\n', 'utf8'))).toBe(true);
    expect(detectPreviewMimeLanguage('etc/hosts', Buffer.from('127.0.0.1 localhost\n', 'utf8'))).toEqual({
      mime: 'text/plain',
      language: 'plaintext',
    });
  });
});
