import * as http from 'http';
import * as fs from 'fs';
import * as nodePath from 'path';
import {
  CAPABILITIES,
  detectPreviewMimeLanguage,
  isPreviewable,
  isTextPreviewable,
  hasCapability,
  listAccessibleFilesystemRoots,
  listAssignableRoleIds,
  listRoleIds,
  resolveFileTarget,
  FileAccessError,
} from 'teepee-core';
import type {
  ResolvedReference as CoreResolvedReference,
  SessionUser,
} from 'teepee-core';
import type { ServerContext } from '../../context.js';
import { jsonResponse } from '../utils.js';

const PREVIEW_MIME_SAMPLE_BYTES = 8192;

type Capability = typeof CAPABILITIES[number];
type AccessibleFileRoot = ReturnType<typeof listAccessibleFilesystemRoots>[number];
type ReferenceAccessResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export interface ApiRouteContext {
  ctx: ServerContext;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  currentUser: SessionUser;

  json: (data: object, status?: number) => void;
  roleHas: (capability: Capability) => boolean;
  requireCapability: (capability: Capability, error?: string) => boolean;

  configuredRoles: string[];
  assignableRoles: string[];
  accessibleFileRoots: AccessibleFileRoot[];
  accessibleFileRootIds: Set<string>;

  ensureReferenceAccess: (resolved: CoreResolvedReference) => ReferenceAccessResult;
  handleResolvedFilePreview: (rootId: string, filePath: string) => void;
  handleResolvedFileDownload: (
    rootId: string,
    filePath: string,
    disposition: 'inline' | 'attachment'
  ) => void;
  handleResolvedDirectoryList: (rootId: string, relativePath: string) => void;
}

export function buildApiRouteContext(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  currentUser: SessionUser
): ApiRouteContext {
  const json = (data: object, status = 200) => jsonResponse(res, data, status);
  const roleHas = (capability: Capability) =>
    hasCapability(ctx.config, currentUser.role, capability);
  const requireCapability = (
    capability: Capability,
    error = 'Insufficient permissions'
  ): boolean => {
    if (!roleHas(capability)) {
      json({ error }, 403);
      return false;
    }
    return true;
  };

  const configuredRoles = listRoleIds(ctx.config);
  const assignableRoles = listAssignableRoleIds(ctx.config);
  const accessibleFileRoots = listAccessibleFilesystemRoots(ctx.config, currentUser.role);
  const accessibleFileRootIds = new Set(accessibleFileRoots.map((root) => root.id));

  const readFileSample = (absolutePath: string): Buffer | undefined => {
    const fd = fs.openSync(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(PREVIEW_MIME_SAMPLE_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, PREVIEW_MIME_SAMPLE_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  };

  const ensureReferenceAccess = (resolved: CoreResolvedReference): ReferenceAccessResult => {
    if (resolved.fetch.kind === 'workspace' && !accessibleFileRootIds.has('workspace')) {
      return { ok: false, status: 403, error: 'Insufficient permissions' };
    }
    if (resolved.fetch.kind === 'filesystem' && !accessibleFileRootIds.has(resolved.fetch.rootId)) {
      return { ok: false, status: 403, error: 'Insufficient permissions' };
    }
    return { ok: true };
  };

  const handleResolvedFilePreview = (rootId: string, filePath: string): void => {
    try {
      const target = resolveFileTarget(ctx.config, currentUser.role, rootId, filePath);
      const stat = fs.statSync(target.absolutePath);
      if (!stat.isFile()) {
        json({ error: 'Only regular files can be previewed' }, 400);
        return;
      }
      const { mime } = detectPreviewMimeLanguage(
        target.relativePath,
        readFileSample(target.absolutePath)
      );
      if (!isPreviewable(mime, stat.size)) {
        json({ error: 'File too large or not previewable', size: stat.size, mime }, 413);
        return;
      }
      if (!isTextPreviewable(mime, stat.size)) {
        json({ binary: true, mime, size: stat.size });
        return;
      }
      const content = fs.readFileSync(target.absolutePath, 'utf-8');
      json({ content, mime, size: stat.size });
    } catch (error: any) {
      if (error instanceof FileAccessError) {
        json({ error: error.message }, error.status);
        return;
      }
      json({ error: 'File not found' }, 404);
    }
  };

  const handleResolvedFileDownload = (
    rootId: string,
    filePath: string,
    disposition: 'inline' | 'attachment'
  ): void => {
    try {
      const target = resolveFileTarget(ctx.config, currentUser.role, rootId, filePath);
      const stat = fs.statSync(target.absolutePath);
      if (!stat.isFile()) {
        json({ error: 'Only regular files can be downloaded' }, 400);
        return;
      }
      const { mime } = detectPreviewMimeLanguage(
        target.relativePath,
        readFileSample(target.absolutePath)
      );
      if (disposition === 'inline' && !isPreviewable(mime, stat.size)) {
        json({ error: 'File too large or not previewable', size: stat.size, mime }, 413);
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': `${disposition}; filename="${nodePath.basename(target.relativePath)}"`,
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(target.absolutePath).pipe(res);
    } catch (error: any) {
      if (error instanceof FileAccessError) {
        json({ error: error.message }, error.status);
        return;
      }
      json({ error: 'File not found' }, 404);
    }
  };

  const handleResolvedDirectoryList = (rootId: string, relativePath: string): void => {
    try {
      const target = resolveFileTarget(ctx.config, currentUser.role, rootId, relativePath);
      const stat = fs.statSync(target.absolutePath);
      if (!stat.isDirectory()) {
        json({ error: 'Only directories can be listed' }, 400);
        return;
      }

      const blockedHostEntries = new Set(['proc', 'sys', 'dev']);
      const entries: Array<{ name: string; path: string; type: 'directory' | 'file' }> = [];
      for (const entry of fs.readdirSync(target.absolutePath, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (target.root.kind === 'host' && blockedHostEntries.has(entry.name)) continue;
        const nextRelativePath = target.relativePath === '.'
          ? entry.name
          : `${target.relativePath}/${entry.name}`;
        if (entry.isDirectory()) {
          entries.push({ name: entry.name, path: nextRelativePath, type: 'directory' });
        } else if (entry.isFile()) {
          entries.push({ name: entry.name, path: nextRelativePath, type: 'file' });
        }
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      json({
        root: { id: target.root.id, kind: target.root.kind, path: target.root.path },
        path: target.relativePath === '.' ? '' : target.relativePath,
        entries,
      });
    } catch (error: any) {
      if (error instanceof FileAccessError) {
        json({ error: error.message }, error.status);
        return;
      }
      json({ error: 'File not found' }, 404);
    }
  };

  return {
    ctx,
    req,
    res,
    url,
    currentUser,
    json,
    roleHas,
    requireCapability,
    configuredRoles,
    assignableRoles,
    accessibleFileRoots,
    accessibleFileRootIds,
    ensureReferenceAccess,
    handleResolvedFilePreview,
    handleResolvedFileDownload,
    handleResolvedDirectoryList,
  };
}
