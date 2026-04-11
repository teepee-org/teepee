import type { MessageRow } from '../db.js';
import type { JobInputRequestPayload } from '../user-input/db.js';

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

export interface AgentJobRetryingEvent {
  type: 'agent.job.retrying';
  topicId: number;
  jobId: number;
  agentName: string;
  attempt: number;
  error: string;
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

export interface AgentJobWaitingInputEvent {
  type: 'agent.job.waiting_input';
  topicId: number;
  jobId: number;
  agentName: string;
  request: JobInputRequestPayload;
}

export interface AgentJobResumedEvent {
  type: 'agent.job.resumed';
  topicId: number;
  jobId: number;
  agentName: string;
  requestId: number;
  answeredByUserId: string;
}

export interface JobInputAnsweredEvent {
  type: 'job.input.answered';
  topicId: number;
  jobId: number;
  requestId: number;
}

export interface JobInputExpiredEvent {
  type: 'job.input.expired';
  topicId: number;
  jobId: number;
  requestId: number;
}

export interface JobInputCancelledEvent {
  type: 'job.input.cancelled';
  topicId: number;
  jobId: number;
  requestId: number;
}

export interface SystemEvent {
  type: 'system';
  topicId: number;
  text: string;
}

export interface TopicsChangedEvent {
  type: 'topics.changed';
}

export interface PresenceChangedEvent {
  type: 'presence.changed';
  presence: PresenceEntry[];
}

export interface PresenceEntry {
  sessionId: string;
  displayName: string;
  role: string;
  activeTopicId: number | null;
  state: 'active' | 'idle';
  lastSeenAt: string;
}

export interface ArtifactCreatedEvent {
  type: 'artifact.created';
  topicId: number;
  artifactId: number;
  versionId: number;
  version: number;
  kind: string;
  title: string;
  messageId: number;
}

export interface ArtifactUpdatedEvent {
  type: 'artifact.updated';
  topicId: number;
  artifactId: number;
  versionId: number;
  version: number;
  kind: string;
  title: string;
  messageId: number;
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
  | AgentJobRetryingEvent
  | AgentJobWaitingInputEvent
  | AgentJobResumedEvent
  | AgentJobCompletedEvent
  | AgentJobFailedEvent
  | JobInputAnsweredEvent
  | JobInputExpiredEvent
  | JobInputCancelledEvent
  | SystemEvent
  | TopicsChangedEvent
  | PresenceChangedEvent
  | ArtifactCreatedEvent
  | ArtifactUpdatedEvent
  | ErrorEvent;

// ── Client → Server events ──

export interface TopicJoinEvent {
  type: 'topic.join';
  topicId: number;
  aroundMessageId?: number;
  radius?: number;
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

export interface PresenceActiveTopicEvent {
  type: 'presence.active_topic';
  topicId: number | null;
}

export interface PresenceHeartbeatEvent {
  type: 'presence.heartbeat';
}

export type ClientEvent =
  | TopicJoinEvent
  | TopicLeaveEvent
  | MessageSendEvent
  | CommandEvent
  | PresenceActiveTopicEvent
  | PresenceHeartbeatEvent;
