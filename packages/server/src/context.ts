import type { Database as DatabaseType } from 'better-sqlite3';
import type { TeepeeConfig, Orchestrator, SessionUser } from 'teepee-core';
import { WebSocket } from 'ws';

export interface ClientState {
  ws: WebSocket;
  user: SessionUser;
  subscribedTopics: Set<number>;
}

export interface ServerContext {
  config: TeepeeConfig;
  db: DatabaseType;
  basePath: string;
  port: number;
  ownerEmail: string;
  ownerSecret: string;
  orchestrator: Orchestrator;
  clients: Set<ClientState>;
  broadcast: (topicId: number, event: object) => void;
}
