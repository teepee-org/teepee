import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import {
  getMessages,
  insertMessage,
  getMessageById,
  executeCommand,
} from 'teepee-core';
import type { CommandContext } from 'teepee-core';
import type { ServerContext, ClientState } from './context.js';
import { authenticateRequest } from './http/utils.js';

export function setupWebSocket(server: http.Server, ctx: ServerContext) {
  const wss = new WebSocketServer({ noServer: true });

  // Reject unauthenticated upgrades
  server.on('upgrade', (req, socket, head) => {
    const user = authenticateRequest(ctx.db, req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const user = authenticateRequest(ctx.db, req);
    if (!user) {
      ws.close(1008, 'Not authenticated');
      return;
    }
    const client: ClientState = { ws, user, subscribedTopics: new Set() };
    ctx.clients.add(client);

    ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString());

        switch (event.type) {
          case 'topic.join': {
            client.subscribedTopics.add(event.topicId);
            const msgs = getMessages(ctx.db, event.topicId, 50);
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
            const email = client.user.email;
            const handle = client.user.handle || client.user.email;
            const messageId = insertMessage(ctx.db, event.topicId, 'user', handle, event.body);
            const userMsg = getMessageById(ctx.db, messageId);
            if (userMsg) {
              ctx.broadcast(event.topicId, { type: 'message.created', topicId: event.topicId, message: userMsg });
            }
            ctx.orchestrator.handlePostedMessage(
              event.topicId, messageId, email, handle, event.body
            ).catch((err: any) => {
              ctx.broadcast(event.topicId, { type: 'system', topicId: event.topicId, text: `Error: ${err?.message || err}` });
            });
            break;
          }

          case 'command': {
            const { command: cmdName, topicId: cmdTopicId, ...cmdParams } = event;
            const cmdCtx: CommandContext = { db: ctx.db, user: client.user, topicId: cmdTopicId, broadcast: ctx.broadcast };
            const cmdResult = executeCommand(cmdName, cmdCtx, cmdParams);
            if (!cmdResult.ok) {
              ws.send(JSON.stringify({ type: 'error', message: cmdResult.error }));
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

    ws.on('close', () => { ctx.clients.delete(client); });
  });

  return wss;
}
