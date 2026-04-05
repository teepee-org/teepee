import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  loadConfig,
  openDb,
  createTopic,
  listTopics,
  getMessages,
  getTopic,
  createUser,
  listUsers,
  setPermission,
  setAlias,
  getTopicAliases,
  insertMessage,
  getEventsAfter,
  getMessageById,
  setTopicLanguage,
  archiveTopic,
  Orchestrator,
  ensureOwner,
  getSession,
  deleteSession,
  acceptInvite,
  createInviteToken,
  createSession,
  validateToken,
  revokeUserFull,
} from '@teepee/core';
import type { TeepeeConfig, OrchestratorCallbacks, SessionUser } from '@teepee/core';
import type { Database as DatabaseType } from 'better-sqlite3';

interface ClientState {
  ws: WebSocket;
  user: SessionUser | null;
  subscribedTopics: Set<number>;
}

export function startServer(
  configPath: string,
  port: number = 3000
): { server: http.Server; close: () => void } {
  const config = loadConfig(configPath);
  const basePath = path.dirname(path.resolve(configPath));
  const dbPath = path.join(basePath, '.teepee', 'db.sqlite');

  // Ensure .teepee directory
  const teepeeDir = path.join(basePath, '.teepee');
  if (!fs.existsSync(teepeeDir)) {
    fs.mkdirSync(teepeeDir, { recursive: true });
  }

  const db = openDb(dbPath);

  // Ensure owner exists
  const ownerEmail = process.env.TEEPEE_OWNER_EMAIL || 'owner@localhost';
  ensureOwner(db, ownerEmail);

  // Generate owner secret (new each start)
  const ownerSecret = crypto.randomBytes(16).toString('hex');

  const clients = new Set<ClientState>();

  // ── Helpers ──

  function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!header) return cookies;
    for (const pair of header.split(';')) {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookies[k] = v.join('=');
    }
    return cookies;
  }

  function getSessionFromReq(req: http.IncomingMessage): SessionUser | null {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['teepee_session'];
    if (!sid) return null;
    return getSession(db, sid);
  }

  function getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
      if (first) return first;
    }
    return req.socket.remoteAddress || '';
  }

  function isBehindHttps(req: http.IncomingMessage): boolean {
    return req.headers['x-forwarded-proto'] === 'https';
  }

  // Central auth: session cookie or nothing. No fallbacks.
  function authenticateRequest(req: http.IncomingMessage): SessionUser | null {
    return getSessionFromReq(req);
  }

  function broadcast(topicId: number, event: object) {
    const data = JSON.stringify(event);
    for (const client of clients) {
      if (client.subscribedTopics.has(topicId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // ── Orchestrator callbacks ──

  const callbacks: OrchestratorCallbacks = {
    onJobStarted(topicId, jobId, agentName) {
      broadcast(topicId, { type: 'agent.job.started', topicId, jobId, agentName });
    },
    onJobStream(topicId, jobId, chunk) {
      broadcast(topicId, { type: 'message.stream', topicId, jobId, chunk });
    },
    onJobCompleted(topicId, jobId, agentName, messageId) {
      const msgs = getMessages(db, topicId, 1);
      const msg = msgs.find((m) => m.id === messageId);
      broadcast(topicId, { type: 'agent.job.completed', topicId, jobId, agentName, message: msg });
    },
    onJobFailed(topicId, jobId, agentName, error) {
      broadcast(topicId, { type: 'agent.job.failed', topicId, jobId, agentName, error });
    },
    onSystemMessage(topicId, text) {
      broadcast(topicId, { type: 'system', topicId, text });
    },
  };

  const orchestrator = new Orchestrator(db, config, basePath, callbacks);

  // ── HTTP handler ──

  function httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    function json(data: object, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }

    function readBody(): Promise<string> {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => resolve(body));
      });
    }

    function setSessionCookie(sessionId: string) {
      const maxAge = 30 * 24 * 60 * 60;
      const secure = isBehindHttps(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `teepee_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    }

    // ── Public auth routes (no session required) ──

    if (url.pathname.match(/^\/auth\/owner\/[a-f0-9]+$/) && req.method === 'GET') {
      const secret = url.pathname.split('/')[3];
      if (secret === ownerSecret) {
        const sid = createSession(db, ownerEmail, 30, req.headers['user-agent'], getClientIp(req));
        setSessionCookie(sid);
        res.writeHead(302, { Location: '/' });
        res.end();
      } else {
        json({ error: 'Invalid owner secret' }, 403);
      }
      return;
    }

    if (url.pathname === '/auth/session' && req.method === 'GET') {
      const user = authenticateRequest(req);
      if (user) {
        json({ email: user.email, handle: user.handle, role: user.role });
      } else {
        json({ error: 'Not authenticated' }, 401);
      }
      return;
    }

    if (url.pathname.match(/^\/auth\/invite\/[a-f0-9]+$/) && req.method === 'GET') {
      const token = url.pathname.split('/')[3];
      const result = validateToken(db, token);
      if (result.valid) {
        json({ valid: true, email: result.email });
      } else {
        json({ valid: false, error: result.error }, 400);
      }
      return;
    }

    if (url.pathname === '/auth/invite/accept' && req.method === 'POST') {
      readBody().then((body) => {
        try {
          const { token, handle } = JSON.parse(body);
          const result = acceptInvite(db, token, handle, undefined,
            req.headers['user-agent'], req.socket.remoteAddress);
          if (result.ok) {
            setSessionCookie(result.sessionId!);
            json({ email: result.user?.email, handle: result.user?.handle, role: result.user?.role });
          } else {
            json({ error: result.error }, 400);
          }
        } catch (e: any) {
          json({ error: e.message }, 400);
        }
      });
      return;
    }

    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies['teepee_session'];
      if (sid) deleteSession(db, sid);
      res.setHeader('Set-Cookie', 'teepee_session=; Path=/; HttpOnly; Max-Age=0');
      json({ ok: true });
      return;
    }

    // ── Auth gate: everything below requires a valid session ──

    const currentUser = authenticateRequest(req);

    if (url.pathname.startsWith('/api/')) {
      if (!currentUser) {
        json({ error: 'Not authenticated' }, 401);
        return;
      }
    }

    // ── Admin routes (owner only) ──

    if (url.pathname === '/api/admin/invite' && req.method === 'POST') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      readBody().then((body) => {
        try {
          const { email, role } = JSON.parse(body);
          try { createUser(db, email, role || 'user'); } catch { /* already exists */ }
          const token = createInviteToken(db, email);
          const { networkInterfaces } = require('os');
          const nets = networkInterfaces();
          let publicIp = 'localhost';
          for (const name of Object.keys(nets)) {
            for (const net of (nets[name] || [])) {
              if (net.family === 'IPv4' && !net.internal) { publicIp = net.address; break; }
            }
            if (publicIp !== 'localhost') break;
          }
          const protocol = isBehindHttps(req) ? 'https' : 'http';
          const host = req.headers['x-forwarded-host'] || req.headers.host || `${publicIp}:${port}`;
          const link = `${protocol}://${host}/invite/${token}`;
          json({ link, token });
        } catch (e: any) {
          json({ error: e.message }, 400);
        }
      });
      return;
    }

    if (url.pathname === '/api/admin/revoke' && req.method === 'POST') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      readBody().then((body) => {
        const { email } = JSON.parse(body);
        revokeUserFull(db, email);
        json({ ok: true });
      });
      return;
    }

    if (url.pathname === '/api/admin/allow' && req.method === 'POST') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      readBody().then((body) => {
        const { email, agents } = JSON.parse(body);
        const list = agents === '*' ? ['*'] : agents.split(',').map((a: string) => a.trim());
        for (const agent of list) setPermission(db, email, null, agent, true);
        json({ ok: true });
      });
      return;
    }

    if (url.pathname === '/api/admin/deny' && req.method === 'POST') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      readBody().then((body) => {
        const { email, agents } = JSON.parse(body);
        const list = agents === '*' ? ['*'] : agents.split(',').map((a: string) => a.trim());
        for (const agent of list) setPermission(db, email, null, agent, false);
        json({ ok: true });
      });
      return;
    }

    // ── Application routes (any authenticated user) ──

    if (url.pathname === '/api/topics' && req.method === 'GET') {
      json(listTopics(db));
      return;
    }

    if (url.pathname === '/api/topics' && req.method === 'POST') {
      if (currentUser!.role === 'observer') { json({ error: 'Observers cannot create topics' }, 403); return; }
      readBody().then((body) => {
        const { name } = JSON.parse(body);
        const id = createTopic(db, name);
        json({ id, name }, 201);
      });
      return;
    }

    if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'GET') {
      const topicId = parseInt(url.pathname.split('/')[3]);
      const limit = parseInt(url.searchParams.get('limit') || '50');
      json(getMessages(db, topicId, limit));
      return;
    }

    if (url.pathname.match(/^\/api\/topics\/\d+\/messages$/) && req.method === 'POST') {
      if (currentUser!.role === 'observer') { json({ error: 'Observers cannot post messages' }, 403); return; }
      readBody().then(async (body) => {
        try {
          const { text } = JSON.parse(body);
          const topicId = parseInt(url.pathname.split('/')[3]);
          // Identity comes from session, never from client body
          const messageId = await orchestrator.handleMessage(
            topicId,
            currentUser!.email,
            currentUser!.handle || currentUser!.email,
            text
          );
          json({ id: messageId }, 201);
        } catch (e: any) {
          json({ error: e.message }, 400);
        }
      });
      return;
    }

    if (url.pathname === '/api/agents' && req.method === 'GET') {
      const agents = Object.entries(config.agents).map(([name, a]) => ({
        name,
        provider: a.provider,
      }));
      json(agents);
      return;
    }

    if (url.pathname === '/api/project' && req.method === 'GET') {
      let gitBranch: string | null = null;
      try {
        const { execSync } = require('child_process');
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: basePath, encoding: 'utf-8' }).trim();
      } catch { /* not a git repo */ }
      json({ name: config.teepee.name, path: basePath, language: config.teepee.language, gitBranch });
      return;
    }

    if (url.pathname === '/api/users' && req.method === 'GET') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      json(listUsers(db));
      return;
    }

    if (url.pathname.match(/^\/api\/topics\/\d+\/language$/) && req.method === 'POST') {
      if (currentUser!.role === 'observer') { json({ error: 'Observers cannot modify topics' }, 403); return; }
      readBody().then((body) => {
        const { language } = JSON.parse(body);
        const topicId = parseInt(url.pathname.split('/')[3]);
        setTopicLanguage(db, topicId, language);
        json({ ok: true });
      });
      return;
    }

    if (url.pathname.match(/^\/api\/topics\/\d+\/alias$/) && req.method === 'POST') {
      if (currentUser!.role !== 'owner') { json({ error: 'Owner only' }, 403); return; }
      readBody().then((body) => {
        const { agent, alias } = JSON.parse(body);
        const topicId = parseInt(url.pathname.split('/')[3]);
        setAlias(db, topicId, alias, agent);
        insertMessage(db, topicId, 'system', 'teepee', `@${agent} is now available as @${alias}`);
        broadcast(topicId, { type: 'system', topicId, text: `@${agent} is now available as @${alias}` });
        json({ ok: true });
      });
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      json({
        name: config.teepee.name,
        topics: listTopics(db).length,
        agents: Object.keys(config.agents).length,
        users: listUsers(db).length,
        clients: clients.size,
      });
      return;
    }

    // ── Static files (SPA shell — no auth required) ──

    const webDist = path.resolve(__dirname, '../../web/dist');
    let filePath = path.join(webDist, url.pathname === '/' ? 'index.html' : url.pathname);

    if (!filePath.startsWith(webDist)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      filePath = path.join(webDist, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  }

  // ── WebSocket ──

  const server = http.createServer(httpHandler);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const user = authenticateRequest(req);
    const client: ClientState = {
      ws,
      user,
      subscribedTopics: new Set(),
    };
    clients.add(client);

    // Reject all application events for unauthenticated clients
    ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString());

        if (!client.user) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          return;
        }

        switch (event.type) {
          case 'topic.join': {
            client.subscribedTopics.add(event.topicId);
            const msgs = getMessages(db, event.topicId, 50);
            ws.send(JSON.stringify({ type: 'topic.history', topicId: event.topicId, messages: msgs }));
            break;
          }

          case 'topic.leave': {
            client.subscribedTopics.delete(event.topicId);
            break;
          }

          case 'message.send': {
            if (client.user.role === 'observer') {
              ws.send(JSON.stringify({ type: 'error', message: 'Observers cannot send messages' }));
              break;
            }
            // Identity from session, never from client payload
            const email = client.user.email;
            const handle = client.user.handle || client.user.email;
            const messageId = insertMessage(db, event.topicId, 'user', handle, event.body);
            const userMsg = getMessageById(db, messageId);
            if (userMsg) {
              broadcast(event.topicId, { type: 'message.created', topicId: event.topicId, message: userMsg });
            }
            orchestrator.handlePostedMessage(
              event.topicId, messageId, email, handle, event.body
            ).catch((err: any) => {
              broadcast(event.topicId, { type: 'system', topicId: event.topicId, text: `Error: ${err?.message || err}` });
            });
            break;
          }

          case 'command': {
            if (client.user.role === 'observer') {
              ws.send(JSON.stringify({ type: 'error', message: 'Observers cannot run commands' }));
              break;
            }
            const topicId = event.topicId;
            switch (event.command) {
              case 'topic.language': {
                setTopicLanguage(db, topicId, event.language);
                const sysMsg = `Language set to **${event.language}**`;
                insertMessage(db, topicId, 'system', 'teepee', sysMsg);
                broadcast(topicId, { type: 'system', topicId, text: sysMsg });
                break;
              }
              case 'topic.rename': {
                db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(event.name, topicId);
                const sysMsg = `Topic renamed to **${event.name}**`;
                insertMessage(db, topicId, 'system', 'teepee', sysMsg);
                broadcast(topicId, { type: 'system', topicId, text: sysMsg });
                break;
              }
              case 'topic.archive': {
                archiveTopic(db, topicId);
                broadcast(topicId, { type: 'system', topicId, text: 'Topic archived.' });
                break;
              }
              case 'topic.alias': {
                if (client.user.role !== 'owner') {
                  ws.send(JSON.stringify({ type: 'error', message: 'Owner only' }));
                  break;
                }
                setAlias(db, topicId, event.alias, event.agent);
                const sysMsg = `@${event.agent} is now available as @${event.alias}`;
                insertMessage(db, topicId, 'system', 'teepee', sysMsg);
                broadcast(topicId, { type: 'system', topicId, text: sysMsg });
                break;
              }
            }
            break;
          }
        }
      } catch (err: any) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
        } catch { /* ws closed */ }
      }
    });

    ws.on('close', () => { clients.delete(client); });
  });

  server.listen(port, '0.0.0.0', () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const ips: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    console.log(`\nTeepee started:\n`);
    console.log(`  Owner login (local):  http://localhost:${port}/auth/owner/${ownerSecret}`);
    if (ips.length > 0) {
      console.log(`  Owner login (remote): http://${ips[0]}:${port}/auth/owner/${ownerSecret}`);
    }
    console.log(`\n  Project: ${config.teepee.name}`);
    console.log(`  Agents:  ${Object.keys(config.agents).join(', ')}`);
    console.log(`\n  Open the owner login link to get started.`);
    console.log(`  The secret changes on every restart.\n`);
  });

  return {
    server,
    close: () => { wss.close(); server.close(); db.close(); },
  };
}
