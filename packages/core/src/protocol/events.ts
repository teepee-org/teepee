import type { MessageRow } from '../db.js';

// ── Server → Client events ──

export interface TopicHistoryEvent {
  type: 'topic.history';
  topicId: number;
  messages: MessageRow[];
}

export interface MessageCreatedEvent {
  type: 'message.created';
  topicId: number;
  message: MessageRow;
}

export interface MessageStreamEvent {
  type: 'message.stream';
  topicId: number;
  jobId: number;
  chunk: string;
}

export interface AgentJobStartedEvent {
  type: 'agent.job.started';
  topicId: number;
  jobId: number;
  agentName: string;
}

export interface AgentJobCompletedEvent {
  type: 'agent.job.completed';
  topicId: number;
  jobId: number;
  agentName: string;
  message: MessageRow;
}

export interface AgentJobFailedEvent {
  type: 'agent.job.failed';
  topicId: number;
  jobId: number;
  agentName: string;
  error: string;
}

export interface SystemEvent {
  type: 'system';
  topicId: number;
  text: string;
}

export interface TopicsChangedEvent {
  type: 'topics.changed';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type ServerEvent =
  | TopicHistoryEvent
  | MessageCreatedEvent
  | MessageStreamEvent
  | AgentJobStartedEvent
  | AgentJobCompletedEvent
  | AgentJobFailedEvent
  | SystemEvent
  | TopicsChangedEvent
  | ErrorEvent;

// ── Client → Server events ──

export interface TopicJoinEvent {
  type: 'topic.join';
  topicId: number;
}

export interface TopicLeaveEvent {
  type: 'topic.leave';
  topicId: number;
}

export interface MessageSendEvent {
  type: 'message.send';
  topicId: number;
  body: string;
}

export interface CommandEvent {
  type: 'command';
  command: string;
  topicId: number;
  [key: string]: any;
}

export type ClientEvent =
  | TopicJoinEvent
  | TopicLeaveEvent
  | MessageSendEvent
  | CommandEvent;
