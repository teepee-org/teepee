import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocket } from 'ws';
import {
  loadConfig,
  openDb,
  getMessages,
  Orchestrator,
  ensureOwner,
  runMigrations,
} from 'teepee-core';
import type { OrchestratorCallbacks } from 'teepee-core';
import type { ServerContext, ClientState } from './context.js';
import { handleAuthRoute } from './http/auth-routes.js';
import { handleApiRoute } from './http/api-routes.js';
import { handleStaticFile } from './http/static.js';
import { applyCors, authenticateRequest, jsonResponse } from './http/utils.js';
import { setupWebSocket } from './ws.js';

export type { ServerContext, ClientState } from './context.js';

export function startServer(
  configPath: string,
  port: number = 3000
): { server: http.Server; close: () => void } {
  const config = loadConfig(configPath);
  const teepeeDir = path.dirname(path.resolve(configPath));
  const basePath = path.dirname(teepeeDir);
  const dbPath = path.join(teepeeDir, 'db.sqlite');

  if (!fs.existsSync(teepeeDir)) {
    fs.mkdirSync(teepeeDir, { recursive: true });
  }

  const db = openDb(dbPath);
  runMigrations(db);
  const ownerEmail = process.env.TEEPEE_OWNER_EMAIL || 'owner@localhost';
  ensureOwner(db, ownerEmail);
  const ownerSecret = crypto.randomBytes(16).toString('hex');

  const clients = new Set<ClientState>();

  function broadcast(topicId: number, event: object) {
    const data = JSON.stringify(event);
    for (const client of clients) {
      if (client.subscribedTopics.has(topicId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function broadcastGlobal(event: object) {
    const data = JSON.stringify(event);
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

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

  const ctx: ServerContext = {
    config, db, basePath, port, ownerEmail, ownerSecret, orchestrator, clients, broadcast, broadcastGlobal,
  };

  // ── HTTP ──

  function httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (!applyCors(config, req, res, port)) {
      jsonResponse(res, { error: 'CORS origin not allowed' }, 403);
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Public auth routes
    if (handleAuthRoute(ctx, req, res, url)) return;

    // Auth gate for /api/*
    if (url.pathname.startsWith('/api/')) {
      const currentUser = authenticateRequest(db, req);
      if (!currentUser) {
        jsonResponse(res, { error: 'Not authenticated' }, 401);
        return;
      }
      if (handleApiRoute(ctx, req, res, url, currentUser)) return;
    }

    // Static files (SPA)
    handleStaticFile(req, res, url);
  }

  const server = http.createServer(httpHandler);
  const wss = setupWebSocket(server, ctx);

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
