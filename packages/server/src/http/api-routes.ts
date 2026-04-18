import * as http from 'http';
import * as fs from 'fs';
import * as nodePath from 'path';
import {
  CAPABILITIES,
  createTopic,
  getTopic,
  listTopics,
  getMessages,
  getMessagesAround,
  createUser,
  listUsers,
  createInviteToken,
  revokeUserFull,
  reEnableUser,
  deleteUserPermanently,
  promoteToOwner,
  demoteFromOwner,
  setUserRole,
  executeCommand,
  listArchivedTopics,
  restoreTopic,
  archiveTopic,
  searchAll,
  listTopicArtifacts,
  listScopedArtifacts,
  searchArtifacts,
  searchScopedArtifacts,
  countArtifactsByTopic,
  countActiveJobsByTopic,
  getArtifact,
  getArtifactVersions,
  getArtifactVersion,
  getArtifactVersionByNumber,
  promoteArtifact,
  getEnrichedMessageArtifacts,
  listVisibleTopicInputRequests,
  getPendingJobInputRequest,
  normalizeLegacyHref,
  resolveReference,
  detectMimeLanguage,
  detectPreviewMimeLanguage,
  isPreviewable,
  isTextPreviewable,
  expirePendingJobInputRequests,
  getTopicLineage,
  renameTopic,
  listActiveJobsForTopic,
  getUser,
  listAccessibleFilesystemRoots,
  listTopicChildren,
  findTopicByPath,
  hasCapability,
  listAssignableRoleIds,
  listRoleCapabilities,
  listRoleIds,
  resolveFileTarget,
  suggestAccessibleFiles,
  FileAccessError,
} from 'teepee-core';
import type { SearchScope, SearchType, ResolvedReference as CoreResolvedReference } from 'teepee-core';
import type { SessionUser, CommandContext } from 'teepee-core';
import type { ServerContext } from '../context.js';
import { submitUserMessage } from '../post-message.js';
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
  const PREVIEW_MIME_SAMPLE_BYTES = 8192;
  const json = (data: object, status = 200) => jsonResponse(res, data, status);
  const roleHas = (capability: typeof CAPABILITIES[number]) =>
    hasCapability(ctx.config, currentUser.role, capability);
  const requireCapability = (
    capability: typeof CAPABILITIES[number],
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

  const ensureReferenceAccess = (resolved: CoreResolvedReference): { ok: true } | { ok: false; status: number; error: string } => {
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

  // ── Admin routes ──

  if (url.pathname === '/api/admin/invite' && req.method === 'POST') {
    if (!requireCapability('users.invite')) return true;
    if (ctx.config.mode !== 'shared') { json({ error: 'Invites are only available in shared mode' }, 403); return true; }
    readBody(req).then((body) => {
      try {
        const { email, role: rawRole } = JSON.parse(body);
        const fallbackRole = assignableRoles.includes('collaborator')
          ? 'collaborator'
          : assignableRoles[0];
        const role = rawRole === 'user' ? 'collaborator' : (rawRole || fallbackRole);
        if (!role || !assignableRoles.includes(role)) {
          json({ error: `Invalid invite role: ${role}. Use one of: ${assignableRoles.join(', ')}` }, 400);
          return;
        }
        try { createUser(ctx.db, email, role); } catch { /* already exists */ }
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
    if (!requireCapability('users.revoke')) return true;
    readBody(req).then((body) => {
      const { email } = JSON.parse(body);
      const ok = revokeUserFull(ctx.db, email);
      if (ok) { json({ ok: true }); } else { json({ error: 'Cannot revoke: user not found, already revoked, or is the last active owner' }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/re-enable' && req.method === 'POST') {
    if (!requireCapability('users.reenable')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = reEnableUser(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot re-enable: user not found or not revoked' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/delete' && req.method === 'POST') {
    if (!requireCapability('users.delete')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = deleteUserPermanently(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot delete: user not found or is the last active owner' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/role' && req.method === 'POST') {
    if (!requireCapability('users.role.set')) return true;
    readBody(req).then((body) => {
      try {
        const { email, role: rawRole } = JSON.parse(body);
        const role = rawRole === 'user' ? 'collaborator' : rawRole;
        if (!role || !configuredRoles.includes(role)) {
          json({ error: `Invalid role: ${role}. Use one of: ${configuredRoles.join(', ')}` }, 400);
          return;
        }
        const targetUser = getUser(ctx.db, email);
        if (!targetUser) {
          json({ error: 'User not found' }, 404);
          return;
        }
        if (role === 'owner' && !roleHas('users.owner.promote')) {
          json({ error: 'Insufficient permissions' }, 403);
          return;
        }
        if (targetUser.role === 'owner' && role !== 'owner' && !roleHas('users.owner.demote')) {
          json({ error: 'Insufficient permissions' }, 403);
          return;
        }
        const result = setUserRole(ctx.db, email, role, currentUser.email);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/access-matrix' && req.method === 'GET') {
    if (!requireCapability('admin.view')) return true;
    json({
      roles: configuredRoles,
      assignable_roles: assignableRoles,
      profiles: ['deny', 'readonly', 'draft', 'readwrite', 'trusted'],
      capabilities: CAPABILITIES,
      agents: Object.entries(ctx.config.agents).map(([name, a]) => ({ name, provider: a.provider })),
      matrix: Object.fromEntries(configuredRoles.map((role) => [role, ctx.config.roles[role]?.agents ?? {}])),
      role_capabilities: Object.fromEntries(configuredRoles.map((role) => [role, listRoleCapabilities(ctx.config, role)])),
      mode: ctx.config.mode,
      source: '.teepee/config.yaml',
      editable: false,
    });
    return true;
  }

  if (url.pathname === '/api/admin/promote' && req.method === 'POST') {
    if (!requireCapability('users.owner.promote')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const result = promoteToOwner(ctx.db, email, currentUser.email);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/demote' && req.method === 'POST') {
    if (!requireCapability('users.owner.demote')) return true;
    readBody(req).then((body) => {
      try {
        const { email, role } = JSON.parse(body);
        const fallbackRole = assignableRoles.includes('collaborator')
          ? 'collaborator'
          : assignableRoles[0];
        const targetRole = role || fallbackRole;
        if (!targetRole || !assignableRoles.includes(targetRole)) {
          json({ error: `Invalid demotion role: ${targetRole}. Use one of: ${assignableRoles.join(', ')}` }, 400);
          return;
        }
        const result = demoteFromOwner(ctx.db, email, currentUser.email, targetRole);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  // ── Application routes ──

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
    readBody(req).then((body) => {
      const { name, parentTopicId } = JSON.parse(body);
      const id = createTopic(ctx.db, name, parentTopicId ?? null);
      const topic = getTopic(ctx.db, id);
      ctx.broadcastGlobal({ type: 'topics.changed' });
      json(topic ?? { id, name }, 201);
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
    readBody(req).then((body) => {
      try {
        const { text, clientMessageId } = JSON.parse(body);
        const topicId = parseInt(url.pathname.split('/')[3]);
        const result = submitUserMessage(ctx, topicId, currentUser, text, clientMessageId);
        json(result, 201);
      } catch (e: any) {
        json({ error: e.message }, 400);
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
    readBody(req).then((body) => {
      const { language } = JSON.parse(body);
      const topicId = parseInt(url.pathname.split('/')[3]);
      const cmdCtx: CommandContext = { db: ctx.db, config: ctx.config, user: currentUser, topicId, broadcast: ctx.broadcast, broadcastGlobal: ctx.broadcastGlobal };
      const result = executeCommand('topic.language', cmdCtx, { language });
      if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 403); }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/topics\/\d+\/alias$/) && req.method === 'POST') {
    readBody(req).then((body) => {
      const { agent, alias } = JSON.parse(body);
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
      try {
        const { repoPath } = JSON.parse(body);
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
        const { execFileSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const fullPath = path.join(ctx.basePath, repoPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, version.body, 'utf-8');
        let commitSha = '';
        try {
          const title = getArtifact(ctx.db, artifactId)?.title ?? String(artifactId);
          execFileSync('git', ['add', '--', repoPath], { cwd: ctx.basePath, encoding: 'utf-8' });
          execFileSync('git', ['commit', '-m', `Promote artifact: ${title}`], { cwd: ctx.basePath, encoding: 'utf-8' });
          commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.basePath, encoding: 'utf-8' }).trim();
        } catch (gitErr: any) {
          json({ error: `Git commit failed: ${gitErr.message}` }, 500);
          return;
        }
        promoteArtifact(ctx.db, artifactId, repoPath, commitSha);
        json({ ok: true, repoPath, commitSha });
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  // ── Message artifacts lookup ──

  if (url.pathname.match(/^\/api\/messages\/\d+\/artifacts$/) && req.method === 'GET') {
    const messageId = parseInt(url.pathname.split('/')[3]);
    json(getEnrichedMessageArtifacts(ctx.db, messageId));
    return true;
  }

  // ── Job input requests ──

  if (url.pathname.match(/^\/api\/topics\/\d+\/input-requests$/) && req.method === 'GET') {
    expirePendingJobInputRequests(ctx.db);
    const topicId = parseInt(url.pathname.split('/')[3]);
    json(listVisibleTopicInputRequests(ctx.db, topicId));
    return true;
  }

  if (url.pathname.match(/^\/api\/jobs\/\d+\/input-request$/) && req.method === 'GET') {
    expirePendingJobInputRequests(ctx.db);
    const jobId = parseInt(url.pathname.split('/')[3]);
    const request = getPendingJobInputRequest(ctx.db, jobId);
    if (!request) {
      json({ error: 'Input request not found' }, 404);
      return true;
    }
    json(request);
    return true;
  }

  if (url.pathname.match(/^\/api\/input-requests\/\d+\/answer$/) && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        expirePendingJobInputRequests(ctx.db);
        const requestId = parseInt(url.pathname.split('/')[3]);
        const payload = JSON.parse(body);
        const resumed = await ctx.orchestrator.resumeJobFromUserInput(requestId, currentUser.id, payload);
        ctx.broadcast(resumed.topicId, {
          type: 'job.input.answered',
          topicId: resumed.topicId,
          jobId: resumed.jobId,
          requestId: resumed.requestId,
        });
        json({ ok: true });
      } catch (e: any) {
        const message = e?.message || String(e);
        const status =
          message.includes('not found') ? 404
            : message.includes('not pending') || message.includes('no longer pending') ? 409
            : message.includes('Only the user who started') ? 403
            : 400;
        json({ error: message }, status);
      }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/input-requests\/\d+\/cancel$/) && req.method === 'POST') {
    readBody(req).then(async () => {
      try {
        expirePendingJobInputRequests(ctx.db);
        const requestId = parseInt(url.pathname.split('/')[3]);
        const cancelled = await ctx.orchestrator.cancelJobFromUserInput(requestId, currentUser.id, currentUser.role);
        ctx.broadcast(cancelled.topicId, {
          type: 'job.input.cancelled',
          topicId: cancelled.topicId,
          jobId: cancelled.jobId,
          requestId,
        });
        json({ ok: true });
      } catch (e: any) {
        const message = e?.message || String(e);
        const status =
          message.includes('not found') ? 404
            : message.includes('not pending') || message.includes('no longer pending') ? 409
            : message.includes('Only the requester or an owner') ? 403
            : 400;
        json({ error: message }, status);
      }
    });
    return true;
  }

  // ── References ──

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
    readBody(req).then((body) => {
      try {
        let { href } = JSON.parse(body);
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
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

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

    interface FileSelectorEntry {
      name: string;
      path: string;
      isDirectory: boolean;
      source: 'fs' | 'tp';
      insertText?: string;
      canonicalUri?: string;
    }

    const LIMIT = 50;
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
        if (count >= LIMIT) break;
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
        if (count >= LIMIT) break;
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
          if (count >= LIMIT) break;
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
