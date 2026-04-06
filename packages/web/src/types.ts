// Re-export shared protocol types from teepee-core.
// Using `import type` to avoid bundling any runtime code from core.
import type { MessageRow } from 'teepee-core';
import type { ServerEvent as CoreServerEvent } from 'teepee-core';
import type { TopicResponse, AgentResponse } from 'teepee-core';

// Domain aliases — keep the names the web codebase already uses.
export type Message = MessageRow;
export type Topic = TopicResponse;
export type Agent = AgentResponse;
export type ServerEvent = CoreServerEvent;

// Job is UI-only state (not in protocol — it's derived from events)
export interface Job {
  id: number;
  batch_id: number;
  agent_name: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  output_message_id: number | null;
  error: string | null;
}
