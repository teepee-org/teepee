import * as fs from 'fs';
import * as nodePath from 'path';
import {
  getArtifact,
  getArtifactVersion,
  getArtifactVersions,
  getEnrichedMessageArtifacts,
  getTopicLineage,
  listScopedArtifacts,
  listTopicArtifacts,
  promoteArtifact,
} from 'teepee-core';
import { readBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

function buildSiblingTempPath(fullPath: string, label: string): string {
  return `${fullPath}.${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rollbackPromotedFile(fullPath: string, previousContent: Buffer | null): void {
  if (previousContent === null) {
    try {
      fs.unlinkSync(fullPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }

  const rollbackPath = buildSiblingTempPath(fullPath, 'rollback');
  try {
    fs.writeFileSync(rollbackPath, previousContent);
    fs.renameSync(rollbackPath, fullPath);
  } catch (error) {
    try { fs.unlinkSync(rollbackPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function handleArtifactRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, res, url, json, requireCapability } = routeCtx;

  // ── Artifacts ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/artifacts$/) && req.method === 'GET') {
    const topicId = parseInt(url.pathname.split('/')[3]);
    const scope = url.searchParams.get('scope') || 'local';
    if (scope === 'inherited') {
      const lineage = getTopicLineage(ctx.db, topicId);
      json(listScopedArtifacts(ctx.db, lineage));
    } else {
      json(listTopicArtifacts(ctx.db, topicId));
    }
    return true;
  }

  if (url.pathname.match(/^\/api\/artifacts\/\d+$/) && req.method === 'GET') {
    const artifactId = parseInt(url.pathname.split('/')[3]);
    const artifact = getArtifact(ctx.db, artifactId);
    if (!artifact) { json({ error: 'Artifact not found' }, 404); return true; }
    json(artifact);
    return true;
  }

  if (url.pathname.match(/^\/api\/artifacts\/\d+\/versions$/) && req.method === 'GET') {
    const artifactId = parseInt(url.pathname.split('/')[3]);
    const artifact = getArtifact(ctx.db, artifactId);
    if (!artifact) { json({ error: 'Artifact not found' }, 404); return true; }
    json(getArtifactVersions(ctx.db, artifactId));
    return true;
  }

  if (url.pathname.match(/^\/api\/artifacts\/\d+\/versions\/\d+$/) && req.method === 'GET') {
    const parts = url.pathname.split('/');
    const artifactId = parseInt(parts[3]);
    const versionId = parseInt(parts[5]);
    const version = getArtifactVersion(ctx.db, artifactId, versionId);
    if (!version) { json({ error: 'Version not found' }, 404); return true; }
    json(version);
    return true;
  }

  if (url.pathname.match(/^\/api\/artifacts\/\d+\/versions\/\d+\/download$/) && req.method === 'GET') {
    const parts = url.pathname.split('/');
    const artifactId = parseInt(parts[3]);
    const versionId = parseInt(parts[5]);
    const version = getArtifactVersion(ctx.db, artifactId, versionId);
    if (!version) { json({ error: 'Version not found' }, 404); return true; }
    const artifact = getArtifact(ctx.db, artifactId);
    const filename = `${artifact?.title?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? 'document'}_v${version.version}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(version.body);
    return true;
  }

  if (url.pathname.match(/^\/api\/artifacts\/\d+\/versions\/\d+\/promote$/) && req.method === 'POST') {
    if (!requireCapability('artifacts.promote')) return true;
    const parts = url.pathname.split('/');
    const artifactId = parseInt(parts[3]);
    const versionId = parseInt(parts[5]);
    readBody(req).then((body) => {
      let parsedBody: any;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        json({ error: 'Invalid JSON body' }, 400);
        return;
      }

      const { repoPath } = parsedBody ?? {};
      if (!repoPath || typeof repoPath !== 'string') {
        json({ error: 'repoPath is required' }, 400);
        return;
      }
      const ALLOWED_PREFIXES = ['doc/', 'docs/', 'spec/'];
      if (!ALLOWED_PREFIXES.some((p) => repoPath.startsWith(p))) {
        json({ error: `repoPath must start with one of: ${ALLOWED_PREFIXES.join(', ')}` }, 400);
        return;
      }
      if (repoPath.includes('..')) {
        json({ error: 'Path traversal not allowed' }, 400);
        return;
      }
      const version = getArtifactVersion(ctx.db, artifactId, versionId);
      if (!version) { json({ error: 'Version not found' }, 404); return; }

      const fullPath = nodePath.join(ctx.basePath, repoPath);
      const dir = nodePath.dirname(fullPath);
      const tmpPath = buildSiblingTempPath(fullPath, 'promote');
      let previousContent: Buffer | null = null;

      try {
        previousContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmpPath, version.body, 'utf-8');
        fs.renameSync(tmpPath, fullPath);
      } catch (writeErr: any) {
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
        json({ error: `Failed to write ${repoPath}: ${writeErr.message}` }, 500);
        return;
      }

      try {
        promoteArtifact(ctx.db, artifactId, repoPath, null);
      } catch (dbErr: any) {
        try {
          rollbackPromotedFile(fullPath, previousContent);
        } catch (rollbackErr: any) {
          json({
            error: `Failed to record promoted artifact for ${repoPath}: ${dbErr.message}. Rollback failed: ${rollbackErr.message}`,
          }, 500);
          return;
        }
        json({ error: `Failed to record promoted artifact for ${repoPath}: ${dbErr.message}` }, 500);
        return;
      }

      json({ ok: true, repoPath });
    });
    return true;
  }

  // ── Message artifacts lookup ──

  if (url.pathname.match(/^\/api\/messages\/\d+\/artifacts$/) && req.method === 'GET') {
    const messageId = parseInt(url.pathname.split('/')[3]);
    json(getEnrichedMessageArtifacts(ctx.db, messageId));
    return true;
  }

  return false;
}
