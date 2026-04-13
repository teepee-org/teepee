import * as path from 'path';
import * as fs from 'fs';
import type { FilesystemRootConfig } from './config.js';

// ── URI types ──

export type ReferenceTargetType = 'workspace-file' | 'filesystem-file' | 'artifact-document' | 'artifact-tree-file';

export interface ParsedTeepeeUri {
  namespace: 'workspace' | 'artifact' | 'fs';
  /** repo-relative path for workspace, artifact id string for artifact */
  resource: string;
  /** For fs: configured root id */
  rootId?: string;
  /** For workspace: line number. For artifact: version number. */
  line?: number;
  column?: number;
  /** For artifact: version number from #vN */
  artifactVersion?: number;
  /** For future filetree: path within artifact */
  treePath?: string;
}

export interface ResolvedReference {
  targetType: ReferenceTargetType;
  canonicalUri: string;
  displayName: string;
  mime: string;
  language: string;
  selection: { line: number | null; column: number | null };
  fetch:
    | { kind: 'workspace'; path: string }
    | { kind: 'filesystem'; rootId: string; path: string }
    | { kind: 'artifact-document'; artifactId: number; version?: number };
}

export interface SuggestItem {
  type: 'workspace_file' | 'filesystem_file' | 'artifact_document';
  label: string;
  insertText: string;
  canonicalUri: string;
  description: string;
  score: number;
}

// ── MIME / language detection ──

const EXT_MAP: Record<string, { mime: string; language: string }> = {
  '.ts': { mime: 'text/typescript', language: 'typescript' },
  '.tsx': { mime: 'text/typescript', language: 'typescriptreact' },
  '.js': { mime: 'text/javascript', language: 'javascript' },
  '.jsx': { mime: 'text/javascript', language: 'javascriptreact' },
  '.json': { mime: 'application/json', language: 'json' },
  '.yaml': { mime: 'text/yaml', language: 'yaml' },
  '.yml': { mime: 'text/yaml', language: 'yaml' },
  '.md': { mime: 'text/markdown', language: 'markdown' },
  '.css': { mime: 'text/css', language: 'css' },
  '.html': { mime: 'text/html', language: 'html' },
  '.py': { mime: 'text/x-python', language: 'python' },
  '.rs': { mime: 'text/x-rust', language: 'rust' },
  '.go': { mime: 'text/x-go', language: 'go' },
  '.java': { mime: 'text/x-java', language: 'java' },
  '.c': { mime: 'text/x-c', language: 'c' },
  '.cpp': { mime: 'text/x-c++', language: 'cpp' },
  '.h': { mime: 'text/x-c', language: 'c' },
  '.sh': { mime: 'text/x-shellscript', language: 'shell' },
  '.bash': { mime: 'text/x-shellscript', language: 'shell' },
  '.sql': { mime: 'text/x-sql', language: 'sql' },
  '.xml': { mime: 'text/xml', language: 'xml' },
  '.svg': { mime: 'image/svg+xml', language: 'xml' },
  '.csv': { mime: 'text/csv', language: 'csv' },
  '.txt': { mime: 'text/plain', language: 'plaintext' },
  '.toml': { mime: 'text/toml', language: 'toml' },
  '.ini': { mime: 'text/ini', language: 'ini' },
  '.dockerfile': { mime: 'text/x-dockerfile', language: 'dockerfile' },
  '.proto': { mime: 'text/x-protobuf', language: 'protobuf' },
  '.graphql': { mime: 'text/x-graphql', language: 'graphql' },
  '.rb': { mime: 'text/x-ruby', language: 'ruby' },
  '.php': { mime: 'text/x-php', language: 'php' },
  '.swift': { mime: 'text/x-swift', language: 'swift' },
  '.kt': { mime: 'text/x-kotlin', language: 'kotlin' },
  '.lua': { mime: 'text/x-lua', language: 'lua' },
  '.r': { mime: 'text/x-r', language: 'r' },
  '.scala': { mime: 'text/x-scala', language: 'scala' },
  '.png': { mime: 'image/png', language: 'binary' },
  '.jpg': { mime: 'image/jpeg', language: 'binary' },
  '.jpeg': { mime: 'image/jpeg', language: 'binary' },
  '.gif': { mime: 'image/gif', language: 'binary' },
  '.webp': { mime: 'image/webp', language: 'binary' },
  '.pdf': { mime: 'application/pdf', language: 'binary' },
};

function detectMimeLanguage(filePath: string): { mime: string; language: string } {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return { mime: 'text/x-dockerfile', language: 'dockerfile' };
  if (basename === 'makefile') return { mime: 'text/x-makefile', language: 'makefile' };
  return EXT_MAP[ext] ?? { mime: 'application/octet-stream', language: 'plaintext' };
}

export function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;

  let suspiciousControlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      suspiciousControlBytes += 1;
    }
  }

  if (suspiciousControlBytes > Math.max(1, Math.floor(buffer.length * 0.02))) {
    return false;
  }

  const decoded = buffer.toString('utf8');
  let replacementChars = 0;
  for (const char of decoded) {
    if (char === '\uFFFD') replacementChars += 1;
  }

  return replacementChars <= Math.max(1, Math.floor(decoded.length * 0.01));
}

export function detectPreviewMimeLanguage(
  filePath: string,
  sample?: Buffer
): { mime: string; language: string } {
  const detected = detectMimeLanguage(filePath);
  if (detected.mime !== 'application/octet-stream' || !sample) return detected;
  if (!isLikelyTextBuffer(sample)) return detected;
  return { mime: 'text/plain', language: 'plaintext' };
}

// ── URI parsing ──

export function parseTeepeeUri(uri: string): ParsedTeepeeUri | null {
  if (!uri.startsWith('teepee:/')) return null;

  const rest = uri.slice('teepee:/'.length);

  if (rest.startsWith('workspace/')) {
    const pathWithFragment = rest.slice('workspace/'.length);
    const hashIdx = pathWithFragment.indexOf('#');
    let filePath: string;
    let line: number | undefined;
    let column: number | undefined;

    if (hashIdx >= 0) {
      filePath = pathWithFragment.slice(0, hashIdx);
      const fragment = pathWithFragment.slice(hashIdx + 1);
      const lineMatch = fragment.match(/^L(\d+)(?:C(\d+))?$/);
      if (lineMatch) {
        line = parseInt(lineMatch[1]);
        if (lineMatch[2]) column = parseInt(lineMatch[2]);
      }
    } else {
      filePath = pathWithFragment;
    }

    if (filePath.includes('..') || filePath.startsWith('/')) return null;

    return { namespace: 'workspace', resource: filePath, line, column };
  }

  if (rest.startsWith('artifact/')) {
    const idWithFragment = rest.slice('artifact/'.length);
    const hashIdx = idWithFragment.indexOf('#');
    let idStr: string;
    let artifactVersion: number | undefined;
    let treePath: string | undefined;

    if (hashIdx >= 0) {
      idStr = idWithFragment.slice(0, hashIdx);
      const fragment = idWithFragment.slice(hashIdx + 1);
      const versionMatch = fragment.match(/^v(\d+)(?:\/path\/(.+))?$/);
      if (versionMatch) {
        artifactVersion = parseInt(versionMatch[1]);
        if (versionMatch[2]) treePath = versionMatch[2];
      }
    } else {
      idStr = idWithFragment;
      const pathIdx = idStr.indexOf('/path/');
      if (pathIdx >= 0) {
        treePath = idStr.slice(pathIdx + '/path/'.length);
        idStr = idStr.slice(0, pathIdx);
      }
    }

    return { namespace: 'artifact', resource: idStr, artifactVersion, treePath };
  }

  if (rest.startsWith('fs/')) {
    const pathWithFragment = rest.slice('fs/'.length);
    const slashIdx = pathWithFragment.indexOf('/');
    if (slashIdx <= 0) return null;

    const rootId = pathWithFragment.slice(0, slashIdx);
    const resourceWithFragment = pathWithFragment.slice(slashIdx + 1);
    const hashIdx = resourceWithFragment.indexOf('#');
    let filePath: string;
    let line: number | undefined;
    let column: number | undefined;

    if (hashIdx >= 0) {
      filePath = resourceWithFragment.slice(0, hashIdx);
      const fragment = resourceWithFragment.slice(hashIdx + 1);
      const lineMatch = fragment.match(/^L(\d+)(?:C(\d+))?$/);
      if (lineMatch) {
        line = parseInt(lineMatch[1]);
        if (lineMatch[2]) column = parseInt(lineMatch[2]);
      }
    } else {
      filePath = resourceWithFragment;
    }

    if (filePath.includes('..') || filePath.startsWith('/')) return null;
    return { namespace: 'fs', rootId, resource: filePath, line, column };
  }

  return null;
}

// ── Legacy href normalization ──

export function normalizeLegacyHref(
  href: string,
  basePath: string,
  roots: FilesystemRootConfig[] = []
): string | null {
  if (href.startsWith('teepee:/')) return href;
  if (href.startsWith('file://')) return null;
  if (!href.startsWith('/')) return null;

  const colonIdx = href.lastIndexOf(':');
  let rawPath = href;
  let lineNum: number | undefined;

  if (colonIdx > 0) {
    const after = href.slice(colonIdx + 1);
    const num = parseInt(after);
    if (!isNaN(num) && String(num) === after) {
      rawPath = href.slice(0, colonIdx);
      lineNum = num;
    }
  }

  const normalizedBase = basePath.endsWith('/') ? basePath : basePath + '/';
  if (rawPath.startsWith(normalizedBase)) {
    const relative = rawPath.slice(normalizedBase.length);
    if (relative.includes('..')) return null;

    let uri = `teepee:/workspace/${relative}`;
    if (lineNum !== undefined) uri += `#L${lineNum}`;
    return uri;
  }

  for (const root of roots) {
    const relativeToRoot = relativePathWithinRoot(rawPath, root.resolvedPath);
    if (!relativeToRoot || relativeToRoot.includes('..')) continue;
    let fileUri = `teepee:/fs/${root.id}/${relativeToRoot}`;
    if (lineNum !== undefined) fileUri += `#L${lineNum}`;
    return fileUri;
  }

  return null;
}

// ── Server-side resolve ──

export function resolveReference(
  uri: string,
  basePath: string,
  roots: FilesystemRootConfig[] = []
): ResolvedReference | null {
  const parsed = parseTeepeeUri(uri);
  if (!parsed) return null;

  if (parsed.namespace === 'workspace') {
    const fullPath = path.join(basePath, parsed.resource);
    const resolved = path.resolve(fullPath);
    const resolvedBase = path.resolve(basePath);
    if (!isWithinRoot(resolved, resolvedBase)) return null;

    try {
      const real = fs.realpathSync(resolved);
      if (!isWithinRoot(real, resolvedBase)) return null;
    } catch {
      // file doesn't exist yet — that's fine for resolve, the fetch will 404
    }

    const { mime, language } = detectMimeLanguage(parsed.resource);
    return {
      targetType: 'workspace-file',
      canonicalUri: uri,
      displayName: path.basename(parsed.resource),
      mime,
      language,
      selection: { line: parsed.line ?? null, column: parsed.column ?? null },
      fetch: { kind: 'workspace', path: parsed.resource },
    };
  }

  if (parsed.namespace === 'fs') {
    const root = roots.find((entry) => entry.id === parsed.rootId);
    if (!root) return null;

    const fullPath = path.join(root.resolvedPath, parsed.resource);
    const resolved = path.resolve(fullPath);
    if (!isWithinRoot(resolved, root.resolvedPath)) return null;

    try {
      const real = fs.realpathSync(resolved);
      if (!isWithinRoot(real, root.resolvedPath)) return null;
    } catch {
      // Missing file is resolved later by fetch.
    }

    const { mime, language } = detectMimeLanguage(parsed.resource);
    return {
      targetType: 'filesystem-file',
      canonicalUri: uri,
      displayName: path.basename(parsed.resource),
      mime,
      language,
      selection: { line: parsed.line ?? null, column: parsed.column ?? null },
      fetch: { kind: 'filesystem', rootId: root.id, path: parsed.resource },
    };
  }

  if (parsed.namespace === 'artifact') {
    const artifactId = parseInt(parsed.resource);
    if (isNaN(artifactId)) return null;

    if (parsed.treePath) {
      return {
        targetType: 'artifact-tree-file',
        canonicalUri: uri,
        displayName: path.basename(parsed.treePath),
        mime: 'application/octet-stream',
        language: 'plaintext',
        selection: { line: null, column: null },
        fetch: { kind: 'artifact-document', artifactId, version: parsed.artifactVersion },
      };
    }

    return {
      targetType: 'artifact-document',
      canonicalUri: uri,
      displayName: `Artifact #${artifactId}`,
      mime: 'text/markdown',
      language: 'markdown',
      selection: { line: null, column: null },
      fetch: { kind: 'artifact-document', artifactId, version: parsed.artifactVersion },
    };
  }

  return null;
}

// ── Workspace file suggestion (used by server) ──

const MAX_PREVIEW_SIZE = 512 * 1024; // 512 KB

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.turbo', '.cache', '__pycache__', '.tox', '.mypy_cache',
  'vendor', 'target',
]);

export function suggestWorkspaceFiles(
  basePath: string,
  query: string,
  limit: number
): SuggestItem[] {
  const results: Array<{ path: string; score: number }> = [];
  const q = query.toLowerCase();

  function walk(dir: string, relPrefix: string, depth: number) {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.teepee') continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        if (!q) {
          results.push({ path: relPath, score: 0 });
        } else {
          const score = scoreMatch(relPath, q);
          if (score > 0) results.push({ path: relPath, score });
        }
      }

      if (results.length > limit * 10) return;
    }
  }

  walk(basePath, '', 0);
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit).map((r) => {
    const basename = path.basename(r.path);
    return {
      type: 'workspace_file' as const,
      label: r.path,
      insertText: `[${basename}](teepee:/workspace/${r.path})`,
      canonicalUri: `teepee:/workspace/${r.path}`,
      description: 'workspace file',
      score: r.score,
    };
  });
}

function scoreMatch(filePath: string, query: string): number {
  const lower = filePath.toLowerCase();
  const basename = path.basename(lower);

  if (basename.startsWith(query)) return 100;
  if (basename.includes(query)) return 80;

  const segments = lower.split('/');
  for (const seg of segments) {
    if (seg.startsWith(query)) return 60;
  }

  if (lower.includes(query)) return 40;
  return 0;
}

export function isPreviewable(mime: string, fileSize: number): boolean {
  if (fileSize > MAX_PREVIEW_SIZE) return false;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json') return true;
  if (mime.startsWith('image/')) return true;
  if (mime === 'application/pdf') return true;
  return false;
}

export function isTextPreviewable(mime: string, fileSize: number): boolean {
  if (fileSize > MAX_PREVIEW_SIZE) return false;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json') return true;
  return false;
}

export { detectMimeLanguage };

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedTarget.startsWith(normalizedRoot);
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

function relativePathWithinRoot(targetPath: string, rootPath: string): string | null {
  if (!isWithinRoot(targetPath, rootPath)) return null;
  const relative = path.relative(rootPath, targetPath).replace(/\\/g, '/');
  if (!relative || relative === '.') return null;
  return relative;
}
