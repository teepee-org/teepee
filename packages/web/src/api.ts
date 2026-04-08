import type { Topic, Agent, Message } from './types';
import type { ProjectResponse, StatusResponse } from 'teepee-core';

const BASE = '/api';

export async function fetchTopics(): Promise<Topic[]> {
  const res = await fetch(`${BASE}/topics`);
  return res.json();
}

export async function createTopic(name: string, parentTopicId?: number | null): Promise<Topic> {
  const res = await fetch(`${BASE}/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parentTopicId: parentTopicId ?? null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create topic' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Presence ──

export interface PresenceEntry {
  sessionId: string;
  displayName: string;
  role: string;
  activeTopicId: number | null;
  state: 'active' | 'idle';
  lastSeenAt: string;
}

export async function fetchPresence(): Promise<PresenceEntry[]> {
  const res = await fetch(`${BASE}/presence`);
  return res.json();
}

export async function fetchMessages(
  topicId: number,
  limit = 50
): Promise<Message[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/messages?limit=${limit}`);
  return res.json();
}

export async function postMessage(
  topicId: number,
  text: string,
  authorName?: string
): Promise<{ id: number }> {
  const res = await fetch(`${BASE}/topics/${topicId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, authorName }),
  });
  return res.json();
}

export type ProjectInfo = ProjectResponse;

export async function fetchProject(): Promise<ProjectInfo> {
  const res = await fetch(`${BASE}/project`);
  return res.json();
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch(`${BASE}/status`);
  return res.json();
}

export async function setTopicAlias(
  topicId: number,
  agent: string,
  alias: string
): Promise<void> {
  await fetch(`${BASE}/topics/${topicId}/alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, alias }),
  });
}

// ── Archive ──

export async function apiArchiveTopic(topicId: number): Promise<void> {
  await fetch(`${BASE}/topics/${topicId}/archive`, { method: 'POST' });
}

export async function fetchArchivedTopics(): Promise<Topic[]> {
  const res = await fetch(`${BASE}/topics/archived`);
  return res.json();
}

export async function apiRestoreTopic(topicId: number): Promise<void> {
  await fetch(`${BASE}/topics/${topicId}/restore`, { method: 'POST' });
}
