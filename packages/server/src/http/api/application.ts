import {
  countActiveJobsByTopic,
  countArtifactsByTopic,
  createTopic,
  executeCommand,
  getMessages,
  getMessagesAround,
  getTopic,
  listActiveJobsForTopic,
  listTopics,
  listUsers,
  searchAll,
} from 'teepee-core';
import type { CommandContext, SearchScope, SearchType } from 'teepee-core';
import { submitUserMessage } from '../../post-message.js';
import { readJsonBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

const MESSAGE_BODY_MAX_BYTES = 8 * 1024 * 1024;

export function handleApplicationRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, url, currentUser, json, requireCapability } = routeCtx;

  if (url.pathname === '/api/topics' && req.method === 'GET') {
    const topics = listTopics(ctx.db);
    const artifactCounts = countArtifactsByTopic(ctx.db);
    const activeJobCounts = countActiveJobsByTopic(ctx.db);
    json(topics.map((t) => {
      const jobCounts = activeJobCounts.get(t.id);
      return {
        ...t,
        has_local_artifacts: (artifactCounts.get(t.id) ?? 0) > 0,
        queued_job_count: jobCounts?.queued ?? 0,
        running_job_count: jobCounts?.running ?? 0,
      };
    }));
    return true;
  }

  if (url.pathname === '/api/topics' && req.method === 'POST') {
    if (!requireCapability('topics.create', 'You are not allowed to create topics')) return true;
    void readJsonBody<{ name?: string; parentTopicId?: number | null }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { name, parentTopicId } = body.value;
      if (typeof name !== 'string') {
        json({ error: 'name is required' }, 400);
        return;
      }
      if (parentTopicId !== undefined && parentTopicId !== null && typeof parentTopicId !== 'number') {
        json({ error: 'parentTopicId must be a number or null' }, 400);
        return;
      }
      try {
        const id = createTopic(ctx.db, name, parentTopicId ?? null);
        const topic = getTopic(ctx.db, id);
        ctx.broadcastGlobal({ type: 'topics.changed' });
        json(topic ?? { id, name }, 201);
      } catch {
        json({ error: 'Failed to create topic' }, 400);
      }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'GET') {
    const topicId = parseInt(url.pathname.split('/')[3]);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    json(getMessages(ctx.db, topicId, limit));
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/messages\/around\/\d+$/) && req.method === 'GET') {
    const parts = url.pathname.split('/');
    const topicId = parseInt(parts[3]);
    const messageId = parseInt(parts[6]);
    const radius = parseInt(url.searchParams.get('radius') || '25');
    const messages = getMessagesAround(ctx.db, topicId, messageId, radius);
    if (!messages) {
      json({ error: 'Message not found in topic' }, 404);
      return true;
    }
    json(messages);
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'POST') {
    if (!requireCapability('messages.post', 'You are not allowed to post messages')) return true;
    void readJsonBody<{ text?: string; clientMessageId?: string }>(req, { maxBytes: MESSAGE_BODY_MAX_BYTES }).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { text, clientMessageId } = body.value;
      if (typeof text !== 'string' || text.trim().length === 0) {
        json({ error: "Field 'text' is required and must be a non-empty string" }, 400);
        return;
      }
      const topicId = parseInt(url.pathname.split('/')[3]);
      if (!getTopic(ctx.db, topicId)) {
        json({ error: 'Topic not found' }, 404);
        return;
      }
      try {
        const result = submitUserMessage(ctx, topicId, currentUser, text, clientMessageId);
        json(result, 201);
      } catch {
        json({ error: 'Failed to post message' }, 500);
      }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/jobs$/) && req.method === 'GET') {
    const topicId = parseInt(url.pathname.split('/')[3]);
    const status = url.searchParams.get('status') || 'all';
    if (status !== 'all' && status !== 'active') {
      json({ error: `Invalid job status filter: ${status}` }, 400);
      return true;
    }
    const jobs = status === 'active'
      ? listActiveJobsForTopic(ctx.db, topicId)
      : [];
    json(jobs);
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const agents = Object.entries(ctx.config.agents).map(([name, a]) => ({ name, provider: a.provider }));
    json(agents);
    return true;
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const type = (url.searchParams.get('type') || 'all') as SearchType;
    const scope = (url.searchParams.get('scope') || 'all') as SearchScope;
    const topicIdParam = url.searchParams.get('topicId');
    const topicId = topicIdParam ? parseInt(topicIdParam) : undefined;
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    const limit = parseInt(url.searchParams.get('limit') || '30');

    if (!['all', 'topics', 'messages'].includes(type)) {
      json({ error: `Invalid search type: ${type}` }, 400);
      return true;
    }
    if (!['all', 'topic', 'subtree'].includes(scope)) {
      json({ error: `Invalid search scope: ${scope}` }, 400);
      return true;
    }
    if ((scope === 'topic' || scope === 'subtree') && !topicId) {
      json({ error: 'topicId is required for scoped search' }, 400);
      return true;
    }

    try {
      json(searchAll(ctx.db, q, type, { scope, topicId, includeArchived, limit }));
    } catch (e: any) {
      json({ error: e.message }, 400);
    }
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
      mode: ctx.config.mode,
      bindHost: ctx.bindHost,
      demo: (ctx.config.teepee as any).demo,
    });
    return true;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (!requireCapability('users.list')) return true;
    json(listUsers(ctx.db));
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/language$/) && req.method === 'POST') {
    void readJsonBody<{ language?: string }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { language } = body.value;
      const topicId = parseInt(url.pathname.split('/')[3]);
      const cmdCtx: CommandContext = { db: ctx.db, config: ctx.config, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand('topic.language', cmdCtx, { language });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 403); }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/alias$/) && req.method === 'POST') {
    void readJsonBody<{ agent?: string; alias?: string }>(req).then((body) => {
      if (!body.ok) {
        json({ error: body.error }, body.status);
        return;
      }
      const { agent, alias } = body.value;
      const topicId = parseInt(url.pathname.split('/')[3]);
      const cmdCtx: CommandContext = { db: ctx.db, config: ctx.config, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand('topic.alias', cmdCtx, { agent, alias });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 403); }
    });
    return true;
  }

  if (url.pathname === '/api/presence' && req.method === 'GET') {
    json(ctx.getPresenceSnapshot());
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

  return false;
}
