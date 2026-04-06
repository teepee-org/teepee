import type { Topic, Agent, Message } from './types';

const BASE = '/api';

export async function fetchTopics(): Promise<Topic[]> {
  const res = await fetch(`${BASE}/topics`);
  return res.json();
}

export async function createTopic(name: string): Promise<Topic> {
  const res = await fetch(`${BASE}/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
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

export interface ProjectInfo {
  name: string;
  path: string;
  language: string;
  gitBranch: string | null;
  demo: {
    enabled: boolean;
    topic_name: string;
    hotkey: string;
    delay_ms: number;
  };
}

export async function fetchProject(): Promise<ProjectInfo> {
  const res = await fetch(`${BASE}/project`);
  return res.json();
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function fetchStatus(): Promise<{
  name: string;
  topics: number;
  agents: number;
  users: number;
}> {
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
