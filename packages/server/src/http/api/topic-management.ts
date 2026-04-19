import {
  archiveTopic,
  executeCommand,
  listArchivedTopics,
  renameTopic,
  restoreTopic,
} from 'teepee-core';
import type { CommandContext } from 'teepee-core';
import { readJsonBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

export function handleTopicManagementRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, url, currentUser, json, requireCapability } = routeCtx;

  // ── Topic move ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/move$/) && req.method === 'POST') {
    if (!requireCapability('topics.move', 'You are not allowed to modify topics')) return true;
    void readJsonBody<{ action?: string; targetId?: number }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { action, targetId } = body.value;
      const topicId = parseInt(url.pathname.split('/')[3]);
      const commandMap: Record<string, string> = {
        root: 'topic.move.root',
        into: 'topic.move.into',
        before: 'topic.move.before',
        after: 'topic.move.after',
      };
      const cmdName = action ? commandMap[action] : undefined;
      if (!cmdName) { json({ error: `Invalid move action: ${action}` }, 400); return; }
      const cmdCtx: CommandContext = { db: ctx.db, config: ctx.config, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand(cmdName, cmdCtx, { targetId });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
    });
    return true;
  }

  // ── Archive ──

  if (url.pathname === '/api/topics/archived' && req.method === 'GET') {
    json(listArchivedTopics(ctx.db));
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/archive$/) && req.method === 'POST') {
    if (!requireCapability('topics.archive', 'You are not allowed to modify topics')) return true;
    const topicId = parseInt(url.pathname.split('/')[3]);
    archiveTopic(ctx.db, topicId);
    ctx.broadcastGlobal({ type: 'topics.changed' });
    json({ ok: true });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/restore$/) && req.method === 'POST') {
    if (!requireCapability('topics.restore', 'You are not allowed to modify topics')) return true;
    const topicId = parseInt(url.pathname.split('/')[3]);
    restoreTopic(ctx.db, topicId);
    ctx.broadcastGlobal({ type: 'topics.changed' });
    json({ ok: true });
    return true;
  }

  // ── Topic rename ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/rename$/) && req.method === 'POST') {
    if (!requireCapability('topics.rename', 'You are not allowed to modify topics')) return true;
    void readJsonBody<{ name?: string }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { name } = body.value;
      if (!name || typeof name !== 'string') { json({ error: 'name is required' }, 400); return; }
      try {
        const topicId = parseInt(url.pathname.split('/')[3]);
        renameTopic(ctx.db, topicId, name);
        ctx.broadcastGlobal({ type: 'topics.changed' });
        json({ ok: true });
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  return false;
}
