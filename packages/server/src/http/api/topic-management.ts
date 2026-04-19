import {
  archiveTopic,
  executeCommand,
  listArchivedTopics,
  renameTopic,
  restoreTopic,
} from 'teepee-core';
import type { CommandContext } from 'teepee-core';
import { readBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

export function handleTopicManagementRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, url, currentUser, json, requireCapability } = routeCtx;

  // ── Topic move ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/move$/) && req.method === 'POST') {
    if (!requireCapability('topics.move', 'You are not allowed to modify topics')) return true;
    readBody(req).then((body) => {
      try {
        const { action, targetId } = JSON.parse(body);
        const topicId = parseInt(url.pathname.split('/')[3]);
        const commandMap: Record<string, string> = {
          root: 'topic.move.root',
          into: 'topic.move.into',
          before: 'topic.move.before',
          after: 'topic.move.after',
        };
        const cmdName = commandMap[action];
        if (!cmdName) { json({ error: `Invalid move action: ${action}` }, 400); return; }
        const cmdCtx: CommandContext = { db: ctx.db, config: ctx.config, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
        const result = executeCommand(cmdName, cmdCtx, { targetId });
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
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
    readBody(req).then((body) => {
      try {
        const { name } = JSON.parse(body);
        if (!name || typeof name !== 'string') { json({ error: 'name is required' }, 400); return; }
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
