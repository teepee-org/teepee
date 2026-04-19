import {
  getArtifact,
  getArtifactVersionByNumber,
  getTopicLineage,
  normalizeLegacyHref,
  resolveReference,
  searchArtifacts,
  searchScopedArtifacts,
  suggestAccessibleFiles,
} from 'teepee-core';
import { readJsonBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

export function handleReferenceRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, url, currentUser, json, ensureReferenceAccess } = routeCtx;

  if (url.pathname === '/api/references/suggest' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const topicIdParam = url.searchParams.get('topicId');
    const topicId = topicIdParam ? parseInt(topicIdParam) : undefined;
    const scope = url.searchParams.get('scope') || 'inherited';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const topicLineage = (topicId && scope !== 'global')
      ? getTopicLineage(ctx.db, topicId)
      : undefined;
    const lineageDistance = topicLineage
      ? new Map(topicLineage.map((id, index) => [id, index]))
      : undefined;

    const fileItems = suggestAccessibleFiles(ctx.config, currentUser.role, q, limit * 2);

    const scopedArtifacts = topicLineage
      ? searchScopedArtifacts(ctx.db, topicLineage, q, limit * 2)
      : searchArtifacts(ctx.db, q, limit * 2);

    const currentTopicId = topicId ?? -1;
    const ql = q.toLowerCase();
    const artifactItems = scopedArtifacts
      .filter((a) => {
        if (!q) return true;
        return (
          a.title.toLowerCase().includes(ql) ||
          a.kind.toLowerCase().includes(ql) ||
          (a.promoted_repo_path && a.promoted_repo_path.toLowerCase().includes(ql))
        );
      })
      .map((a) => {
        const distance = lineageDistance?.get(a.topic_id);
        let score = 0;
        if (ql) {
          const tl = a.title.toLowerCase();
          if (tl === ql) score = distance !== undefined ? 180 : 90;
          else if (tl.startsWith(ql)) score = distance !== undefined ? 150 : 70;
          else if (tl.includes(ql)) score = distance !== undefined ? 120 : 50;
          else score = distance !== undefined ? 80 : 30;
        }
        if (distance !== undefined) {
          score += 400 - distance * 50;
        } else if (a.topic_id === currentTopicId) {
          score += 200;
        }
        const scopeLabel = distance === undefined
          ? 'all docs'
          : distance === 0
            ? 'this topic'
            : distance === 1
              ? 'parent topic'
              : `ancestor +${distance}`;
        return {
          type: 'artifact_document' as const,
          label: a.title,
          insertText: `[${a.title}](teepee:/artifact/${a.id})`,
          canonicalUri: `teepee:/artifact/${a.id}`,
          description: `${a.kind} artifact · ${scopeLabel}`,
          score,
        };
      });

    type RankedReferenceItem = {
      type: 'workspace_file' | 'filesystem_file' | 'workspace_dir' | 'filesystem_dir' | 'artifact_document';
      label: string;
      insertText: string;
      canonicalUri: string;
      description: string;
      score: number;
      continueAutocomplete?: boolean;
    };

    const rankedItems: RankedReferenceItem[] = [...fileItems, ...artifactItems]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.label.localeCompare(b.label);
      })
      .slice(0, limit);

    const items = rankedItems.map(({ score: _, ...item }) => item);

    json({ items });
    return true;
  }

  if (url.pathname === '/api/references/resolve' && req.method === 'POST') {
    void readJsonBody<{ href?: string }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      let { href } = body.value;
      if (!href || typeof href !== 'string') {
        json({ error: 'href is required' }, 400);
        return;
      }

      const normalized = normalizeLegacyHref(href, ctx.basePath, ctx.config.filesystem.roots);
      if (normalized) href = normalized;

      const resolved = resolveReference(href, ctx.basePath, ctx.config.filesystem.roots);
      if (!resolved) {
        json({ error: 'Cannot resolve reference' }, 404);
        return;
      }

      const access = ensureReferenceAccess(resolved);
      if (!access.ok) {
        json({ error: access.error }, access.status);
        return;
      }

      if (resolved.targetType === 'artifact-document' && resolved.fetch.kind === 'artifact-document') {
        const artifact = getArtifact(ctx.db, resolved.fetch.artifactId);
        if (!artifact) {
          json({ error: 'Artifact not found' }, 404);
          return;
        }
        if (resolved.fetch.version !== undefined) {
          const version = getArtifactVersionByNumber(ctx.db, resolved.fetch.artifactId, resolved.fetch.version);
          if (!version) {
            json({ error: `Artifact version v${resolved.fetch.version} not found` }, 404);
            return;
          }
        }
        resolved.displayName = artifact.title;
      }

      json(resolved);
    });
    return true;
  }

  return false;
}
