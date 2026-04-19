import * as fs from 'fs';
import {
  findTopicByPath,
  listTopicArtifacts,
  listTopicChildren,
  resolveFileTarget,
} from 'teepee-core';
import type { ApiRouteContext } from './context.js';

const FILE_SELECTOR_LIMIT = 50;

interface FileSelectorEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  source: 'fs' | 'tp';
  insertText?: string;
  canonicalUri?: string;
}

export function handleFilesystemRoutes(routeCtx: ApiRouteContext): boolean {
  const {
    ctx,
    req,
    url,
    currentUser,
    json,
    accessibleFileRoots,
    accessibleFileRootIds,
    handleResolvedDirectoryList,
    handleResolvedFileDownload,
    handleResolvedFilePreview,
  } = routeCtx;

  if (url.pathname === '/api/fs/roots' && req.method === 'GET') {
    json({
      roots: accessibleFileRoots.map((root) => ({
        id: root.id,
        kind: root.kind,
        path: root.path,
      })),
    });
    return true;
  }

  if (url.pathname === '/api/fs/file' && req.method === 'GET') {
    const rootId = url.searchParams.get('root');
    const filePath = url.searchParams.get('path');
    if (!rootId || !filePath || typeof rootId !== 'string' || typeof filePath !== 'string') {
      json({ error: 'root and path are required' }, 400);
      return true;
    }
    handleResolvedFilePreview(rootId, filePath);
    return true;
  }

  if (url.pathname === '/api/fs/entries' && req.method === 'GET') {
    const rootId = url.searchParams.get('root');
    const filePath = url.searchParams.get('path') || '.';
    if (!rootId || typeof rootId !== 'string' || typeof filePath !== 'string') {
      json({ error: 'root is required' }, 400);
      return true;
    }
    handleResolvedDirectoryList(rootId, filePath);
    return true;
  }

  if (url.pathname === '/api/fs/download' && req.method === 'GET') {
    const rootId = url.searchParams.get('root');
    const filePath = url.searchParams.get('path');
    const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
    if (!rootId || !filePath || typeof rootId !== 'string' || typeof filePath !== 'string') {
      json({ error: 'root and path are required' }, 400);
      return true;
    }
    handleResolvedFileDownload(rootId, filePath, disposition);
    return true;
  }

  // ── Pipe file selector ──

  if (url.pathname === '/api/files' && req.method === 'GET') {
    const source = (url.searchParams.get('source') || 'all') as 'all' | 'fs' | 'tp';
    const pathParam = url.searchParams.get('path') || '';
    const query = url.searchParams.get('query') || '';

    const entries: FileSelectorEntry[] = [];

    // Normalize: "/" means root listing, "./" means workspace CWD
    const isRootPath = !pathParam || pathParam === '/';
    const isCwdPath = pathParam === './' || pathParam === '.';

    // Helper: list directory contents for a given fs root + subPath
    const listFsDir = (rootId: string, subPath: string) => {
      const target = resolveFileTarget(ctx.config, currentUser.role, rootId, subPath || '.');
      const stat = fs.statSync(target.absolutePath);
      if (!stat.isDirectory()) return;
      const dirEntries = fs.readdirSync(target.absolutePath, { withFileTypes: true });
      let count = 0;
      for (const entry of dirEntries) {
        if (count >= FILE_SELECTOR_LIMIT) break;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        if (entry.name.startsWith('.') && (!query || !query.startsWith('.'))) continue;
        if (query && !entry.name.toLowerCase().startsWith(query.toLowerCase())) continue;

        const isDir = entry.isDirectory();
        const relPath = target.relativePath === '.'
          ? entry.name
          : `${target.relativePath}/${entry.name}`;
        const canonicalUri = rootId === 'workspace'
          ? `teepee:/workspace/${relPath}`
          : `teepee:/fs/${rootId}/${relPath}`;

        entries.push({
          name: entry.name,
          path: `${rootId}:${relPath}`,
          isDirectory: isDir,
          source: 'fs',
          insertText: isDir ? undefined : `[${entry.name}](${canonicalUri})`,
          canonicalUri,
        });
        count++;
      }
    };

    // ── Filesystem source ──
    if (source === 'all' || source === 'fs') {
      try {
        if (isRootPath) {
          // "/" or empty: list available filesystem roots as directories
          for (const root of accessibleFileRoots) {
            const name = root.id;
            if (query && !name.toLowerCase().startsWith(query.toLowerCase())) continue;
            entries.push({
              name,
              path: `${root.id}:`,
              isDirectory: true,
              source: 'fs',
            });
          }
        } else if (isCwdPath) {
          // "./" : list workspace root contents (or first available root)
          const wsRoot = accessibleFileRoots.find((r) => r.id === 'workspace') || accessibleFileRoots[0];
          if (wsRoot) listFsDir(wsRoot.id, '.');
        } else {
          // Accepted path formats:
          //   "rootId:subpath" or "rootId:"    (explicit colon form)
          //   "rootId/subpath" or "rootId/"    (slash form, as built by client after entering a root directory)
          //   "rootId"                         (bare root id)
          let rootId = '';
          let subPath = '';
          const colonIdx = pathParam.indexOf(':');
          if (colonIdx >= 0) {
            rootId = pathParam.slice(0, colonIdx);
            subPath = pathParam.slice(colonIdx + 1);
          } else {
            const slashIdx = pathParam.indexOf('/');
            rootId = slashIdx >= 0 ? pathParam.slice(0, slashIdx) : pathParam;
            subPath = slashIdx >= 0 ? pathParam.slice(slashIdx + 1) : '';
          }
          // Normalize trailing slashes in subPath; empty becomes "."
          subPath = subPath.replace(/\/+$/, '') || '.';
          if (accessibleFileRootIds.has(rootId)) {
            listFsDir(rootId, subPath);
          }
        }
      } catch {
        // Silently ignore fs errors
      }
    }

    // Helper: list topics + artifacts at a given parent
    const listTopicDir = (parentId: number | null, pathPrefix: string) => {
      let count = 0;
      const children = listTopicChildren(ctx.db, parentId);
      for (const child of children) {
        if (count >= FILE_SELECTOR_LIMIT) break;
        if (query && !child.name.toLowerCase().startsWith(query.toLowerCase())) continue;
        entries.push({
          name: child.name,
          path: pathPrefix ? `${pathPrefix}/${child.name}` : child.name,
          isDirectory: true,
          source: 'tp',
        });
        count++;
      }
      if (parentId !== null) {
        const artifacts = listTopicArtifacts(ctx.db, parentId);
        for (const artifact of artifacts) {
          if (count >= FILE_SELECTOR_LIMIT) break;
          if (query && !artifact.title.toLowerCase().startsWith(query.toLowerCase())) continue;
          const canonicalUri = `teepee:/artifact/${artifact.id}`;
          entries.push({
            name: artifact.title,
            path: pathPrefix ? `${pathPrefix}/${artifact.title}` : artifact.title,
            isDirectory: false,
            source: 'tp',
            insertText: `[${artifact.title}](${canonicalUri})`,
            canonicalUri,
          });
          count++;
        }
      }
    };

    // ── Topic/artifact source ──
    if (source === 'all' || source === 'tp') {
      try {
        if (isRootPath || isCwdPath) {
          // "/" or "./" or empty: list root-level topics
          listTopicDir(null, '');
        } else {
          // Walk topic path — strip leading "./" or "/" (fs conventions don't apply to topics)
          let normalized = pathParam;
          if (normalized.startsWith('./')) normalized = normalized.slice(2);
          if (normalized.startsWith('/')) normalized = normalized.slice(1);
          const segments = normalized.split('/').filter(Boolean);
          if (segments.length > 0) {
            const parentTopic = findTopicByPath(ctx.db, segments);
            if (parentTopic) {
              listTopicDir(parentTopic.id, pathParam.replace(/\/+$/, ''));
            }
          } else {
            // After normalization, empty → root listing
            listTopicDir(null, '');
          }
        }
      } catch {
        // Silently ignore topic errors
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'fs' ? -1 : 1;
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    json({ entries });
    return true;
  }

  if (url.pathname === '/api/workspace/file' && req.method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath || typeof filePath !== 'string') {
      json({ error: 'path is required' }, 400);
      return true;
    }
    handleResolvedFilePreview('workspace', filePath);
    return true;
  }

  if (url.pathname === '/api/workspace/download' && req.method === 'GET') {
    const filePath = url.searchParams.get('path');
    const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
    if (!filePath || typeof filePath !== 'string') {
      json({ error: 'path is required' }, 400);
      return true;
    }
    handleResolvedFileDownload('workspace', filePath, disposition);
    return true;
  }

  return false;
}
