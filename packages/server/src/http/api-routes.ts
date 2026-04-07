import * as http from 'http';
import {
  createTopic,
  listTopics,
  getMessages,
  createUser,
  listUsers,
  setPermission,
  createInviteToken,
  revokeUserFull,
  reEnableUser,
  deleteUserPermanently,
  executeCommand,
  listArchivedTopics,
  restoreTopic,
  archiveTopic,
} from 'teepee-core';
import type { SessionUser, CommandContext } from 'teepee-core';
import type { ServerContext } from '../context.js';
import {
  jsonResponse,
  readBody,
  isBehindHttps,
  getRequestHost,
} from './utils.js';

/**
 * Handle /api/* routes. Returns true if matched.
 * Caller must ensure `currentUser` is authenticated.
 */
export function handleApiRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  currentUser: SessionUser
): boolean {
  const json = (data: object, status = 200) => jsonResponse(res, data, status);

  // ── Admin routes (owner only) ──

  if (url.pathname === '/api/admin/invite' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      try {
        const { email, role } = JSON.parse(body);
        try { createUser(ctx.db, email, role || 'user'); } catch { /* already exists */ }
        const token = createInviteToken(ctx.db, email);
        const { networkInterfaces } = require('os');
        const nets = networkInterfaces();
        let publicIp = 'localhost';
        for (const name of Object.keys(nets)) {
          for (const net of (nets[name] || [])) {
            if (net.family === 'IPv4' && !net.internal) { publicIp = net.address; break; }
          }
          if (publicIp !== 'localhost') break;
        }
        const host = req.headers.host ? getRequestHost(ctx.config, req, ctx.port) : `${publicIp}:${ctx.port}`;
        const link = `${isBehindHttps(ctx.config, req) ? 'https' : 'http'}://${host}/invite/${token}`;
        json({ link, token });
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  if (url.pathname === '/api/admin/revoke' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      const { email } = JSON.parse(body);
      revokeUserFull(ctx.db, email);
      json({ ok: true });
    });
    return true;
  }

  if (url.pathname === '/api/admin/re-enable' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = reEnableUser(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot re-enable: user not found, not revoked, or is owner' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/delete' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = deleteUserPermanently(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot delete: user not found or is owner' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/admin\/permissions\/[^/]+$/) && req.method === 'GET') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    const email = decodeURIComponent(url.pathname.split('/')[4]);
    const { getPermissions } = require('teepee-core');
    const perms = getPermissions(ctx.db, email, null);
    json(perms);
    return true;
  }

  if (url.pathname === '/api/admin/allow' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      const { email, agents } = JSON.parse(body);
      const list = agents === '*' ? ['*'] : agents.split(',').map((a: string) => a.trim());
      for (const agent of list) setPermission(ctx.db, email, null, agent, true);
      json({ ok: true });
    });
    return true;
  }

  if (url.pathname === '/api/admin/deny' && req.method === 'POST') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    readBody(req).then((body) => {
      const { email, agents } = JSON.parse(body);
      const list = agents === '*' ? ['*'] : agents.split(',').map((a: string) => a.trim());
      for (const agent of list) setPermission(ctx.db, email, null, agent, false);
      json({ ok: true });
    });
    return true;
  }

  // ── Application routes ──

  if (url.pathname === '/api/topics' && req.method === 'GET') {
    json(listTopics(ctx.db));
    return true;
  }

  if (url.pathname === '/api/topics' && req.method === 'POST') {
    if (currentUser.role === 'observer') { json({ error: 'Observers cannot create topics' }, 403); return true; }
    readBody(req).then((body) => {
      const { name } = JSON.parse(body);
      const id = createTopic(ctx.db, name);
      json({ id, name }, 201);
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'GET') {
    const topicId = parseInt(url.pathname.split('/')[3]);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    json(getMessages(ctx.db, topicId, limit));
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'POST') {
    if (currentUser.role === 'observer') { json({ error: 'Observers cannot post messages' }, 403); return true; }
    readBody(req).then(async (body) => {
      try {
        const { text } = JSON.parse(body);
        const topicId = parseInt(url.pathname.split('/')[3]);
        const messageId = await ctx.orchestrator.handleMessage(
          topicId, currentUser.email, currentUser.handle || currentUser.email, text
        );
        json({ id: messageId }, 201);
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const agents = Object.entries(ctx.config.agents).map(([name, a]) => ({ name, provider: a.provider }));
    json(agents);
    return true;
  }

  if (url.pathname === '/api/project' && req.method === 'GET') {
    let gitBranch: string | null = null;
    try {
      const { execSync } = require('child_process');
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ctx.basePath, encoding: 'utf-8' }).trim();
    } catch { /* not a git repo */ }
    json({
      name: ctx.config.teepee.name,
      path: ctx.basePath,
      language: ctx.config.teepee.language,
      gitBranch,
      demo: (ctx.config.teepee as any).demo,
    });
    return true;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (currentUser.role !== 'owner') { json({ error: 'Owner only' }, 403); return true; }
    json(listUsers(ctx.db));
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/language$/) && req.method === 'POST') {
    readBody(req).then((body) => {
      const { language } = JSON.parse(body);
      const topicId = parseInt(url.pathname.split('/')[3]);
      const cmdCtx: CommandContext = { db: ctx.db, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand('topic.language', cmdCtx, { language });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 403); }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/alias$/) && req.method === 'POST') {
    readBody(req).then((body) => {
      const { agent, alias } = JSON.parse(body);
      const topicId = parseInt(url.pathname.split('/')[3]);
      const cmdCtx: CommandContext = { db: ctx.db, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand('topic.alias', cmdCtx, { agent, alias });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 403); }
    });
    return true;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    json({
      name: ctx.config.teepee.name,
      topics: listTopics(ctx.db).length,
      agents: Object.keys(ctx.config.agents).length,
      users: listUsers(ctx.db).length,
      clients: ctx.clients.size,
    });
    return true;
  }

  // ── Topic move ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/move$/) && req.method === 'POST') {
    if (currentUser.role === 'observer') { json({ error: 'Observers cannot modify topics' }, 403); return true; }
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
        const cmdCtx: CommandContext = { db: ctx.db, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
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
    if (currentUser.role === 'observer') { json({ error: 'Observers cannot modify topics' }, 403); return true; }
    const topicId = parseInt(url.pathname.split('/')[3]);
    archiveTopic(ctx.db, topicId);
    json({ ok: true });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/restore$/) && req.method === 'POST') {
    if (currentUser.role === 'observer') { json({ error: 'Observers cannot modify topics' }, 403); return true; }
    const topicId = parseInt(url.pathname.split('/')[3]);
    restoreTopic(ctx.db, topicId);
    json({ ok: true });
    return true;
  }

  return false;
}
