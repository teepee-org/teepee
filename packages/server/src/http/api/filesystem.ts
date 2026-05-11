import * as fs from 'fs';
import * as nodePath from 'path';
import * as crypto from 'crypto';
import {
  FileAccessError,
  findTopicByPath,
  listTopicArtifacts,
  listTopicChildren,
  resolveFileTarget,
} from 'teepee-core';
import { readJsonBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

const FILE_SELECTOR_LIMIT = 50;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const MKDIR_NAME_MAX_LEN = 255;
type ConflictPolicy = 'fail' | 'rename' | 'overwrite';

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

  // ── Owner-only write endpoints ──

  if (url.pathname === '/api/fs/upload' && req.method === 'POST') {
    if (currentUser.role !== 'owner') {
      json({ error: 'Insufficient permissions' }, 403);
      return true;
    }

    const rootId = url.searchParams.get('root');
    const dirParam = url.searchParams.get('path') ?? '.';
    const filenameRaw = url.searchParams.get('filename');
    const onConflictRaw = url.searchParams.get('on_conflict') ?? 'fail';

    if (!rootId || typeof rootId !== 'string') {
      json({ error: 'root is required' }, 400);
      return true;
    }
    if (typeof dirParam !== 'string') {
      json({ error: 'path is required' }, 400);
      return true;
    }
    if (!filenameRaw || typeof filenameRaw !== 'string') {
      json({ error: 'filename is required' }, 400);
      return true;
    }

    const filename = sanitizeBasename(filenameRaw);
    if (!filename) {
      json({ error: 'Invalid filename' }, 400);
      return true;
    }
    if (onConflictRaw !== 'fail' && onConflictRaw !== 'rename' && onConflictRaw !== 'overwrite') {
      json({ error: 'on_conflict must be fail, rename, or overwrite' }, 400);
      return true;
    }
    const onConflict = onConflictRaw as ConflictPolicy;

    let parentTarget;
    try {
      parentTarget = resolveFileTarget(ctx.config, currentUser.role, rootId, dirParam || '.');
    } catch (err: any) {
      if (err instanceof FileAccessError) {
        json({ error: err.message }, err.status);
        return true;
      }
      json({ error: 'Failed to resolve target directory' }, 500);
      return true;
    }
    let parentStat;
    try {
      parentStat = fs.statSync(parentTarget.absolutePath);
    } catch {
      json({ error: 'Target directory not found' }, 404);
      return true;
    }
    if (!parentStat.isDirectory()) {
      json({ error: 'Target path is not a directory' }, 400);
      return true;
    }

    let finalName = filename;
    let finalRelPath = joinRootRelative(parentTarget.relativePath, finalName);
    let resolvedTarget;
    try {
      resolvedTarget = resolveFileTarget(ctx.config, currentUser.role, rootId, finalRelPath, { allowMissing: true });
    } catch (err: any) {
      if (err instanceof FileAccessError) {
        json({ error: err.message }, err.status);
        return true;
      }
      json({ error: 'Failed to resolve target file' }, 500);
      return true;
    }

    if (fs.existsSync(resolvedTarget.absolutePath)) {
      if (onConflict === 'fail') {
        const suggested = suggestAvailableName(parentTarget.absolutePath, filename);
        json({ error: 'File already exists', suggestedName: suggested }, 409);
        return true;
      }
      if (onConflict === 'rename') {
        finalName = suggestAvailableName(parentTarget.absolutePath, filename);
        finalRelPath = joinRootRelative(parentTarget.relativePath, finalName);
        try {
          resolvedTarget = resolveFileTarget(ctx.config, currentUser.role, rootId, finalRelPath, { allowMissing: true });
        } catch (err: any) {
          if (err instanceof FileAccessError) {
            json({ error: err.message }, err.status);
            return true;
          }
          json({ error: 'Failed to resolve renamed target' }, 500);
          return true;
        }
      } else {
        const existingStat = fs.statSync(resolvedTarget.absolutePath);
        if (!existingStat.isFile()) {
          json({ error: 'Target exists and is not a regular file' }, 409);
          return true;
        }
      }
    }

    const tmpPath = `${resolvedTarget.absolutePath}.partial.${crypto.randomBytes(8).toString('hex')}`;
    const writeStream = fs.createWriteStream(tmpPath, { flags: 'wx' });
    let totalBytes = 0;
    let settled = false;
    let endReceived = false;

    const fail = (status: number, error: string) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
      req.removeAllListeners('close');
      writeStream.destroy();
      fs.promises.unlink(tmpPath).catch(() => undefined);
      try { req.resume(); } catch { /* noop */ }
      json({ error }, status);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > UPLOAD_MAX_BYTES) {
        fail(413, 'Payload too large');
        return;
      }
      if (!writeStream.write(chunk)) {
        req.pause();
        writeStream.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });
    req.on('end', () => {
      if (settled) return;
      endReceived = true;
      writeStream.end(() => {
        if (settled) return;
        try {
          fs.renameSync(tmpPath, resolvedTarget.absolutePath);
        } catch (err: any) {
          settled = true;
          fs.promises.unlink(tmpPath).catch(() => undefined);
          json({ error: 'Failed to finalize upload' }, 500);
          return;
        }
        settled = true;
        try {
          ctx.broadcastGlobal({
            kind: 'fs:invalidate',
            root: rootId,
            path: parentTarget.relativePath === '.' ? '' : parentTarget.relativePath,
          });
        } catch { /* broadcasting must never break the response */ }
        json({
          ok: true,
          root: rootId,
          path: resolvedTarget.relativePath,
          name: finalName,
          size: totalBytes,
          renamed: finalName !== filename,
        }, 201);
      });
    });
    req.on('error', () => fail(400, 'Failed to read request body'));
    req.on('close', () => {
      if (!settled && !endReceived) fail(400, 'Request body stream closed unexpectedly');
    });
    writeStream.on('error', () => fail(500, 'Failed to write upload'));

    return true;
  }

  if (url.pathname === '/api/fs/mkdir' && req.method === 'POST') {
    if (currentUser.role !== 'owner') {
      json({ error: 'Insufficient permissions' }, 403);
      return true;
    }
    void readJsonBody<{ root?: string; path?: string; name?: string }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { root: rootId, path: dirParam, name: rawName } = body.value;
      if (!rootId || typeof rootId !== 'string') {
        json({ error: 'root is required' }, 400);
        return;
      }
      const parentPath = typeof dirParam === 'string' && dirParam.length > 0 ? dirParam : '.';
      if (!rawName || typeof rawName !== 'string') {
        json({ error: 'name is required' }, 400);
        return;
      }
      const name = sanitizeBasename(rawName);
      if (!name) {
        json({ error: 'Invalid name' }, 400);
        return;
      }

      let parentTarget;
      try {
        parentTarget = resolveFileTarget(ctx.config, currentUser.role, rootId, parentPath);
      } catch (err: any) {
        if (err instanceof FileAccessError) {
          json({ error: err.message }, err.status);
          return;
        }
        json({ error: 'Failed to resolve target directory' }, 500);
        return;
      }
      let parentStat;
      try {
        parentStat = fs.statSync(parentTarget.absolutePath);
      } catch {
        json({ error: 'Target directory not found' }, 404);
        return;
      }
      if (!parentStat.isDirectory()) {
        json({ error: 'Target path is not a directory' }, 400);
        return;
      }

      const childRel = joinRootRelative(parentTarget.relativePath, name);
      let resolvedChild;
      try {
        resolvedChild = resolveFileTarget(ctx.config, currentUser.role, rootId, childRel, { allowMissing: true });
      } catch (err: any) {
        if (err instanceof FileAccessError) {
          json({ error: err.message }, err.status);
          return;
        }
        json({ error: 'Failed to resolve new directory path' }, 500);
        return;
      }
      if (fs.existsSync(resolvedChild.absolutePath)) {
        json({ error: 'A file or directory with that name already exists' }, 409);
        return;
      }
      try {
        fs.mkdirSync(resolvedChild.absolutePath);
      } catch (err: any) {
        json({ error: 'Failed to create directory' }, 500);
        return;
      }
      try {
        ctx.broadcastGlobal({
          kind: 'fs:invalidate',
          root: rootId,
          path: parentTarget.relativePath === '.' ? '' : parentTarget.relativePath,
        });
      } catch { /* broadcasting must never break the response */ }
      json({ ok: true, root: rootId, path: resolvedChild.relativePath, name }, 201);
    });
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

function sanitizeBasename(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('\0')) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  if (trimmed.length > MKDIR_NAME_MAX_LEN) return null;
  const basename = nodePath.basename(trimmed);
  if (basename !== trimmed) return null;
  return basename;
}

function joinRootRelative(parentRel: string, name: string): string {
  if (!parentRel || parentRel === '.') return name;
  return `${parentRel}/${name}`;
}

function suggestAvailableName(dirAbsolutePath: string, originalName: string): string {
  const ext = nodePath.extname(originalName);
  const stem = ext ? originalName.slice(0, -ext.length) : originalName;
  for (let i = 1; i <= 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(nodePath.join(dirAbsolutePath, candidate))) {
      return candidate;
    }
  }
  return `${stem}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}
