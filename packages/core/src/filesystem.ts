import * as fs from 'fs';
import * as path from 'path';
import {
  getFilesystemRoot,
  listAccessibleFilesystemRoots,
  type FilesystemRootConfig,
  type TeepeeConfig,
} from './config.js';

export interface ResolvedFileTarget {
  root: FilesystemRootConfig;
  relativePath: string;
  absolutePath: string;
}

export interface FileSuggestionItem {
  type: 'workspace_file' | 'filesystem_file' | 'workspace_dir' | 'filesystem_dir';
  label: string;
  insertText: string;
  canonicalUri: string;
  description: string;
  score: number;
  continueAutocomplete?: boolean;
}

export class FileAccessError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'FileAccessError';
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.turbo', '.cache', '__pycache__', '.tox', '.mypy_cache',
  'vendor', 'target',
]);

const BLOCKED_HOST_SEGMENTS = new Set([
  'proc',
  'sys',
  'dev',
]);

export function resolveFileTarget(
  config: TeepeeConfig,
  role: string,
  rootId: string,
  rawPath: string,
  options: { allowMissing?: boolean } = {}
): ResolvedFileTarget {
  const root = getFilesystemRoot(config, rootId);
  if (!root) {
    throw new FileAccessError(`Filesystem root '${rootId}' not found`, 404);
  }

  const accessibleRoots = new Set(listAccessibleFilesystemRoots(config, role).map((entry) => entry.id));
  if (!accessibleRoots.has(rootId)) {
    throw new FileAccessError('Insufficient permissions', 403);
  }

  const relativePath = normalizeRootRelativePath(rawPath);
  if (root.kind === 'host' && touchesBlockedHostSegment(relativePath)) {
    throw new FileAccessError('Access to this host path is not allowed', 403);
  }

  const absolutePath = path.resolve(root.resolvedPath, relativePath);
  if (!isWithinRoot(absolutePath, root.resolvedPath)) {
    throw new FileAccessError('Path outside allowed root', 403);
  }

  if (options.allowMissing) {
    const parentPath = path.dirname(absolutePath);
    if (!fs.existsSync(parentPath)) {
      throw new FileAccessError('File not found', 404);
    }
    const realParent = fs.realpathSync(parentPath);
    if (!isWithinRoot(realParent, root.resolvedPath)) {
      throw new FileAccessError('Symlink escape', 403);
    }
  } else {
    if (!fs.existsSync(absolutePath)) {
      throw new FileAccessError('File not found', 404);
    }
    const realTarget = fs.realpathSync(absolutePath);
    if (!isWithinRoot(realTarget, root.resolvedPath)) {
      throw new FileAccessError('Symlink escape', 403);
    }
  }

  return { root, relativePath, absolutePath };
}

export function suggestAccessibleFiles(
  config: TeepeeConfig,
  role: string,
  query: string,
  limit: number
): FileSuggestionItem[] {
  const items: Array<{ root: FilesystemRootConfig; path: string; score: number; isDirectory: boolean }> = [];
  const accessibleRoots = listAccessibleFilesystemRoots(config, role);
  const parsedQuery = parseSuggestionQuery(query, accessibleRoots);
  const candidateRoots = parsedQuery.rootId
    ? accessibleRoots.filter((root) => root.id === parsedQuery.rootId)
    : accessibleRoots;

  for (const root of candidateRoots) {
    if (parsedQuery.pathPrefix !== null) {
      suggestFilesAtPathPrefix(config, role, root, parsedQuery.pathPrefix, limit, items);
      continue;
    }
    if (root.kind === 'host' && !parsedQuery.fuzzyQuery) continue;
    walkRoot(root, parsedQuery.fuzzyQuery, limit, items);
    if (items.length >= limit * 10) break;
  }

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return items
    .slice(0, limit)
    .map(({ root, path: relativePath, score, isDirectory }) => ({
      ...buildSuggestionItem(root, relativePath, isDirectory, parsedQuery),
      score,
    }));
}

function parseSuggestionQuery(
  rawQuery: string,
  accessibleRoots: FilesystemRootConfig[]
): {
  rootId: string | null;
  fuzzyQuery: string;
  pathPrefix: string | null;
  prefixStyle: 'plain' | 'host_absolute' | 'root_colon' | 'root_slash';
} {
  let query = rawQuery.trim();
  let rootId: string | null = null;
  let prefixStyle: 'plain' | 'host_absolute' | 'root_colon' | 'root_slash' = 'plain';

  for (const root of accessibleRoots) {
    const lowerQuery = query.toLowerCase();
    const colonPrefix = `${root.id.toLowerCase()}:`;
    const slashPrefix = `${root.id.toLowerCase()}/`;
    if (lowerQuery.startsWith(colonPrefix)) {
      rootId = root.id;
      query = query.slice(colonPrefix.length);
      prefixStyle = 'root_colon';
      break;
    }
    if (lowerQuery.startsWith(slashPrefix)) {
      rootId = root.id;
      query = query.slice(slashPrefix.length);
      prefixStyle = 'root_slash';
      break;
    }
  }

  if (!rootId && query.startsWith('/')) {
    prefixStyle = 'host_absolute';
  }

  const fuzzyQuery = query.toLowerCase();
  const pathPrefix = isPathScopedQuery(query)
    ? normalizeSuggestionPathPrefix(query)
    : null;

  return { rootId, fuzzyQuery, pathPrefix, prefixStyle };
}

function isPathScopedQuery(query: string): boolean {
  if (!query) return false;
  return query.startsWith('/') || query.startsWith('./') || query.includes('/');
}

function normalizeSuggestionPathPrefix(rawPath: string): string | null {
  let value = rawPath.trim().replace(/\\/g, '/');
  if (!value) return '';
  if (value.startsWith('./')) value = value.slice(2);
  if (value.startsWith('/')) value = value.slice(1);

  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.includes('\0')) {
    return null;
  }
  return normalized;
}

function suggestFilesAtPathPrefix(
  config: TeepeeConfig,
  role: string,
  root: FilesystemRootConfig,
  pathPrefix: string,
  limit: number,
  items: Array<{ root: FilesystemRootConfig; path: string; score: number; isDirectory: boolean }>
): void {
  const trimmedPrefix = pathPrefix.replace(/\/+$/, '');
  const targetsDirectory = pathPrefix.endsWith('/');
  const directoryPath = targetsDirectory
    ? (trimmedPrefix || '.')
    : trimmedPrefix.includes('/')
      ? path.posix.dirname(trimmedPrefix)
      : '.';
  const basenamePrefix = targetsDirectory
    ? ''
    : trimmedPrefix.includes('/')
      ? path.posix.basename(trimmedPrefix)
      : trimmedPrefix;

  try {
    const target = resolveFileTarget(config, role, root.id, directoryPath);
    const stat = fs.statSync(target.absolutePath);
    if (!stat.isDirectory()) return;

    const basenamePrefixLower = basenamePrefix.toLowerCase();
    const normalizedPrefixLower = trimmedPrefix.toLowerCase();
    const entries = fs.readdirSync(target.absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      if (items.length > limit * 10) return;
      if (shouldSkipEntry(root, entry)) continue;
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !entry.isFile()) continue;
      if (basenamePrefixLower && !entry.name.toLowerCase().startsWith(basenamePrefixLower)) continue;

      const relPath = target.relativePath === '.'
        ? entry.name
        : `${target.relativePath}/${entry.name}`;
      const relPathLower = relPath.toLowerCase();
      const score = normalizedPrefixLower && relPathLower.startsWith(normalizedPrefixLower)
        ? isDirectory ? 150 : 140
        : basenamePrefixLower
          ? isDirectory ? 130 : 120
          : isDirectory ? 110 : 100;
      items.push({ root, path: relPath, score, isDirectory });
    }
  } catch {
    // Path-prefix suggestions are best-effort; invalid or missing directories just yield no matches.
  }
}

function walkRoot(
  root: FilesystemRootConfig,
  query: string,
  limit: number,
  items: Array<{ root: FilesystemRootConfig; path: string; score: number; isDirectory: boolean }>
): void {
  const maxDepth = root.kind === 'workspace' ? 8 : 6;

  function walk(dir: string, relPrefix: string, depth: number) {
    if (depth > maxDepth || items.length > limit * 10) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldSkipEntry(root, entry)) continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Score the directory itself as a candidate
        if (query) {
          const score = scoreMatch(relPath, query);
          if (score > 0) {
            items.push({ root, path: relPath, score: score + (root.kind === 'workspace' ? 20 : 0), isDirectory: true });
          }
        } else {
          items.push({ root, path: relPath, score: 0, isDirectory: true });
        }
        walk(fullPath, relPath, depth + 1);
      } else if (entry.isFile()) {
        if (!query) {
          items.push({ root, path: relPath, score: 0, isDirectory: false });
        } else {
          const score = scoreMatch(relPath, query);
          if (score > 0) {
            items.push({ root, path: relPath, score: score + (root.kind === 'workspace' ? 20 : 0), isDirectory: false });
          }
        }
      }
    }
  }

  walk(root.resolvedPath, '', 0);
}

function buildSuggestionItem(
  root: FilesystemRootConfig,
  relativePath: string,
  isDirectory: boolean,
  parsedQuery: {
    rootId: string | null;
    fuzzyQuery: string;
    pathPrefix: string | null;
    prefixStyle: 'plain' | 'host_absolute' | 'root_colon' | 'root_slash';
  }
): Omit<FileSuggestionItem, 'score'> {
  const normalizedPath = relativePath.replace(/\/+$/, '');

  if (!isDirectory) {
    const basename = path.basename(normalizedPath);
    const canonicalUri = root.id === 'workspace'
      ? `teepee:/workspace/${normalizedPath}`
      : `teepee:/fs/${root.id}/${normalizedPath}`;

    return {
      type: root.id === 'workspace' ? 'workspace_file' : 'filesystem_file',
      label: root.id === 'workspace' ? normalizedPath : `${root.id}/${normalizedPath}`,
      insertText: `[${basename}](${canonicalUri})`,
      canonicalUri,
      description: root.kind === 'workspace' ? 'workspace file' : `${root.id} file`,
    };
  }

  const directoryPath = `${normalizedPath}/`;
  const canonicalUri = root.id === 'workspace'
    ? `teepee:/workspace/${directoryPath}`
    : `teepee:/fs/${root.id}/${directoryPath}`;

  return {
    type: root.id === 'workspace' ? 'workspace_dir' : 'filesystem_dir',
    label: root.id === 'workspace' ? directoryPath : `${root.id}/${directoryPath}`,
    insertText: formatDirectoryInsertText(root, directoryPath, parsedQuery),
    canonicalUri,
    description: root.kind === 'workspace' ? 'workspace directory' : `${root.id} directory`,
    continueAutocomplete: true,
  };
}

function formatDirectoryInsertText(
  root: FilesystemRootConfig,
  directoryPath: string,
  parsedQuery: {
    rootId: string | null;
    fuzzyQuery: string;
    pathPrefix: string | null;
    prefixStyle: 'plain' | 'host_absolute' | 'root_colon' | 'root_slash';
  }
): string {
  if (parsedQuery.rootId === root.id) {
    if (parsedQuery.prefixStyle === 'root_slash') {
      return `[[${root.id}/${directoryPath}`;
    }
    if (parsedQuery.prefixStyle === 'root_colon') {
      const rootedPath = root.kind === 'host' ? `/${directoryPath}` : directoryPath;
      return `[[${root.id}:${rootedPath}`;
    }
  }

  if (root.kind === 'host' && parsedQuery.prefixStyle === 'host_absolute') {
    return `[[/${directoryPath}`;
  }

  if (root.kind === 'host') {
    return `[[${root.id}:/${directoryPath}`;
  }

  return `[[${directoryPath}`;
}

function shouldSkipEntry(root: FilesystemRootConfig, entry: fs.Dirent): boolean {
  if (entry.isSymbolicLink()) return true;
  if (root.kind === 'workspace') {
    if (entry.name.startsWith('.') && entry.name !== '.teepee') return true;
    return IGNORED_DIRS.has(entry.name);
  }
  if (BLOCKED_HOST_SEGMENTS.has(entry.name)) return true;
  return false;
}

function scoreMatch(filePath: string, query: string): number {
  const lower = filePath.toLowerCase();
  const basename = path.basename(lower);

  if (basename.startsWith(query)) return 100;
  if (basename.includes(query)) return 80;

  const segments = lower.split('/');
  for (const segment of segments) {
    if (segment.startsWith(query)) return 60;
  }

  if (lower.includes(query)) return 40;
  return 0;
}

function normalizeRootRelativePath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return '.';
  }

  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new FileAccessError('Invalid path', 400);
  }
  if (normalized.includes('/../') || normalized.includes('\0')) {
    throw new FileAccessError('Invalid path', 400);
  }
  return normalized;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedTarget.startsWith(normalizedRoot);
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

function touchesBlockedHostSegment(relativePath: string): boolean {
  if (relativePath === '.' || relativePath === '') return false;
  return relativePath.split('/').some((segment) => BLOCKED_HOST_SEGMENTS.has(segment));
}
