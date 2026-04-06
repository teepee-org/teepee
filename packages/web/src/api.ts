import type { Topic, Agent, Message } from './types';
import type { ProjectResponse, StatusResponse, DividerResponse, SubjectResponse } from 'teepee-core';

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

// ── Dividers ──

export async function fetchDividers(): Promise<DividerResponse[]> {
  const res = await fetch(`${BASE}/dividers`);
  return res.json();
}

export async function apiCreateDivider(name: string): Promise<DividerResponse> {
  const res = await fetch(`${BASE}/dividers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function apiRenameDivider(id: number, name: string): Promise<void> {
  await fetch(`${BASE}/dividers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function apiDeleteDivider(id: number): Promise<void> {
  await fetch(`${BASE}/dividers/${id}`, { method: 'DELETE' });
}

export async function apiReorderDividers(orderedIds: number[]): Promise<void> {
  await fetch(`${BASE}/dividers/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
}

// ── Subjects ──

export async function fetchSubjects(): Promise<SubjectResponse[]> {
  const res = await fetch(`${BASE}/subjects`);
  return res.json();
}

export async function apiCreateSubject(
  name: string,
  dividerId?: number | null,
  parentId?: number | null
): Promise<SubjectResponse> {
  const res = await fetch(`${BASE}/subjects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dividerId, parentId }),
  });
  return res.json();
}

export async function apiRenameSubject(id: number, name: string): Promise<void> {
  await fetch(`${BASE}/subjects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function apiDeleteSubject(id: number): Promise<void> {
  await fetch(`${BASE}/subjects/${id}`, { method: 'DELETE' });
}

export async function apiMoveSubject(id: number, dividerId?: number | null, parentId?: number | null): Promise<void> {
  await fetch(`${BASE}/subjects/${id}/move`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dividerId, parentId }),
  });
}

export async function apiReorderSubjects(parentId: number | null, orderedIds: number[]): Promise<void> {
  await fetch(`${BASE}/subjects/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, orderedIds }),
  });
}

// ── Topic organization ──

export async function apiMoveTopic(topicId: number, dividerId?: number | null, subjectId?: number | null): Promise<void> {
  await fetch(`${BASE}/topics/${topicId}/move`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dividerId, subjectId }),
  });
}

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
