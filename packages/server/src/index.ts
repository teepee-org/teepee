import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocket } from 'ws';
import {
  loadConfig,
  migrateConfigFileToV2,
  openDb,
  getMessages,
  getMessageById,
  expirePendingJobInputRequests,
  failInterruptedJobs,
  Orchestrator,
  ensureOwner,
  runMigrations,
  collectNonStreamingProviderWarnings,
} from 'teepee-core';
import type { OrchestratorCallbacks, TeepeeConfig } from 'teepee-core';

function warnNonStreamingProviders(config: TeepeeConfig): void {
  for (const warning of collectNonStreamingProviderWarnings(config.providers)) {
    console.warn(warning);
  }
}
import type { ServerContext, ClientState } from './context.js';
import { handleAuthRoute } from './http/auth-routes.js';
import { handleApiRoute } from './http/api-routes.js';
import { handleStaticFile } from './http/static.js';
import { applyCors, authenticateRequest, jsonResponse } from './http/utils.js';
import { setupWebSocket } from './ws.js';

export type { ServerContext, ClientState } from './context.js';

export interface StartServerOptions {
  host?: string;
  idleThresholdMs?: number;
  idleCheckIntervalMs?: number;
}

export function startServer(
  configPath: string,
  port: number = 3000,
  options: StartServerOptions = {}
): { server: http.Server; close: () => void } {
  const bindHost = options.host || '127.0.0.1';
  const idleThresholdMs = options.idleThresholdMs ?? 90_000;
  const idleCheckIntervalMs = options.idleCheckIntervalMs ?? 15_000;
  const migration = migrateConfigFileToV2(configPath, { write: true });
  if (migration.migrated) {
    if (migration.sourceVersion === 1) {
      console.warn('Legacy config v1 detected.');
      console.warn('Config migrated automatically to v2.');
    } else {
      console.warn('Config normalized automatically to the latest v2 schema.');
    }
    if (migration.backupPath) {
      console.warn(`Backup written to: ${migration.backupPath}`);
    }
  }
  const config = loadConfig(configPath);
  warnNonStreamingProviders(config);
  const teepeeDir = path.dirname(path.resolve(configPath));
  const basePath = path.dirname(teepeeDir);
  const dbPath = path.join(teepeeDir, 'db.sqlite');
  const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';

  if (config.mode === 'private' && !isLoopback) {
    throw new Error("Private mode can only bind to a loopback host. Set mode: shared in .teepee/config.yaml for network access.");
  }

  if (!fs.existsSync(teepeeDir)) {
    fs.mkdirSync(teepeeDir, { recursive: true });
  }

  const db = openDb(dbPath);
  runMigrations(db);
  failInterruptedJobs(db);
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
    onJobRetrying(topicId, jobId, agentName, attempt, error) {
      broadcast(topicId, { type: 'agent.job.retrying', topicId, jobId, agentName, attempt, error });
    },
    onJobRoundStarted(topicId, jobId, agentName, round, phase) {
      broadcast(topicId, { type: 'agent.job.round_started', topicId, jobId, agentName, round, phase });
    },
    onJobActivity(topicId, jobId, agentName, event) {
      broadcast(topicId, { type: 'agent.job.activity', topicId, jobId, agentName, event });
    },
    onJobWaitingInput(topicId, jobId, agentName, request) {
      broadcast(topicId, { type: 'agent.job.waiting_input', topicId, jobId, agentName, request });
    },
    onJobResumed(topicId, jobId, agentName, requestId, answeredByUserId) {
      broadcast(topicId, { type: 'agent.job.resumed', topicId, jobId, agentName, requestId, answeredByUserId });
    },
    onJobCompleted(topicId, jobId, agentName, messageId) {
      const msgs = getMessages(db, topicId, 1);
      const msg = msgs.find((m) => m.id === messageId);
      broadcast(topicId, { type: 'agent.job.completed', topicId, jobId, agentName, message: msg });
    },
    onJobFailed(topicId, jobId, agentName, error, options) {
      broadcast(topicId, {
        type: 'agent.job.failed',
        topicId,
        jobId,
        agentName,
        error,
        ...(options?.timedOut ? { timedOut: true } : {}),
      });
    },
    onSystemMessage(topicId, messageId, text) {
      const message = getMessageById(db, messageId);
      if (message) {
        broadcast(topicId, { type: 'message.created', topicId, message });
      } else {
        broadcast(topicId, { type: 'system', topicId, text });
      }
    },
    onRuntimeChanged() {
      broadcastGlobal({ type: 'topics.changed' });
    },
  };

  const orchestrator = new Orchestrator(db, config, basePath, callbacks);

  function getPresenceSnapshotFn() {
    const now = Date.now();
    const entries: Array<{
      sessionId: string; displayName: string; role: string;
      activeTopicId: number | null; state: 'active' | 'idle'; lastSeenAt: string;
    }> = [];
    for (const c of clients) {
      entries.push({
        sessionId: c.sessionId,
        displayName: c.user.handle || c.user.email,
        role: c.user.role,
        activeTopicId: c.activeTopicId,
        state: (now - c.lastSeenAt) > idleThresholdMs ? 'idle' : 'active',
        lastSeenAt: new Date(c.lastSeenAt).toISOString(),
      });
    }
    return entries;
  }

  const ctx: ServerContext = {
    config, db, basePath, port, ownerEmail, ownerSecret, orchestrator, clients, broadcast, broadcastGlobal,
    bindHost,
    getPresenceSnapshot: getPresenceSnapshotFn,
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
      if (config.mode === 'private' && currentUser.role !== 'owner') {
        jsonResponse(res, { error: 'Private mode is owner-only' }, 403);
        return;
      }
      if (handleApiRoute(ctx, req, res, url, currentUser)) return;
    }

    // Static files (SPA)
    handleStaticFile(req, res, url);
  }

  const server = http.createServer(httpHandler);
  const wss = setupWebSocket(server, ctx);

  // Periodically check for idle transitions and broadcast presence changes
  const idleCheckInterval = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const c of clients) {
      const wasIdle = c.lastBroadcastPresenceState === 'idle';
      const isIdle = (now - c.lastSeenAt) > idleThresholdMs;
      if (wasIdle !== isIdle) {
        changed = true;
        c.lastBroadcastPresenceState = isIdle ? 'idle' : 'active';
      }
    }
    if (changed) {
      const snapshot = ctx.getPresenceSnapshot();
      ctx.broadcastGlobal({ type: 'presence.changed', presence: snapshot });
    }
  }, idleCheckIntervalMs);

  const inputExpiryInterval = setInterval(() => {
    const expired = expirePendingJobInputRequests(db);
    for (const item of expired) {
      broadcast(item.topicId, {
        type: 'job.input.expired',
        topicId: item.topicId,
        jobId: item.jobId,
        requestId: item.requestId,
      });
      broadcast(item.topicId, {
        type: 'agent.job.failed',
        topicId: item.topicId,
        jobId: item.jobId,
        agentName: item.agentName,
        error: 'User input request expired before answer',
      });
    }
  }, 15_000);

  server.listen(port, bindHost, () => {
    console.log(`\nTeepee started:\n`);
    console.log(`  Owner login (local):  http://localhost:${port}/auth/owner/${ownerSecret}`);
    if (!isLoopback) {
      const { networkInterfaces } = require('os');
      const nets = networkInterfaces();
      const ips: string[] = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
      }
      if (ips.length > 0) {
        console.log(`  Owner login (remote): http://${ips[0]}:${port}/auth/owner/${ownerSecret}`);
      }
    }
    console.log(`\n  Project: ${config.teepee.name}`);
    console.log(`  Mode:    ${config.mode}`);
    console.log(`  Agents:  ${Object.keys(config.agents).join(', ')}`);
    console.log(`\n  Open the owner login link to get started.`);
    console.log(`  The secret changes on every restart.\n`);
  });

  return {
    server,
    close: () => { clearInterval(idleCheckInterval); clearInterval(inputExpiryInterval); wss.close(); server.close(); db.close(); },
  };
}
