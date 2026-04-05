export interface Message {
  id: number;
  topic_id: number;
  author_type: 'user' | 'agent' | 'system';
  author_name: string;
  body: string;
  created_at: string;
}

export interface Topic {
  id: number;
  name: string;
  language: string | null;
  archived: number;
}

export interface Agent {
  name: string;
  provider: string;
}

export interface Job {
  id: number;
  batch_id: number;
  agent_name: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  output_message_id: number | null;
  error: string | null;
}

export type ServerEvent =
  | { type: 'topic.history'; topicId: number; messages: Message[] }
  | { type: 'message.created'; topicId: number; message: Message }
  | { type: 'message.stream'; topicId: number; jobId: number; chunk: string }
  | { type: 'agent.job.started'; topicId: number; jobId: number; agentName: string }
  | { type: 'agent.job.completed'; topicId: number; jobId: number; agentName: string; message: Message }
  | { type: 'agent.job.failed'; topicId: number; jobId: number; agentName: string; error: string }
  | { type: 'system'; topicId: number; text: string }
  | { type: 'error'; message: string };
