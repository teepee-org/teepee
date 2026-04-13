import type { Topic, Agent, Message } from './types';
import type { ProjectResponse, SearchResponse, SearchScope, SearchType, StatusResponse, JobInputRequestResponse } from 'teepee-core';

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

export async function fetchMessagesAround(
  topicId: number,
  messageId: number,
  radius = 25
): Promise<Message[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/messages/around/${messageId}?radius=${radius}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load message context' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function searchTeepee(params: {
  q: string;
  type?: SearchType;
  scope?: SearchScope;
  topicId?: number | null;
  includeArchived?: boolean;
  limit?: number;
}): Promise<SearchResponse> {
  const query = new URLSearchParams();
  query.set('q', params.q);
  if (params.type) query.set('type', params.type);
  if (params.scope) query.set('scope', params.scope);
  if (params.topicId) query.set('topicId', String(params.topicId));
  if (params.includeArchived) query.set('includeArchived', '1');
  if (params.limit) query.set('limit', String(params.limit));

  const res = await fetch(`${BASE}/search?${query.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Search failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function postMessage(
  topicId: number,
  text: string,
  authorName?: string,
  clientMessageId?: string
): Promise<{ id: number; message?: Message }> {
  const res = await fetch(`${BASE}/topics/${topicId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, authorName, clientMessageId }),
  });
  const data = await res.json().catch(() => ({ error: 'Failed to post message' }));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export interface TopicJobSnapshot {
  id: number;
  agent_name: string;
  status: 'queued' | 'running';
  output_message_id: number | null;
  error: string | null;
}

export async function fetchActiveTopicJobs(topicId: number): Promise<TopicJobSnapshot[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/jobs?status=active`);
  const data = await res.json().catch(() => ({ error: 'Failed to load active jobs' }));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ── Human input checkpoints ──

export type PendingInputRequest = JobInputRequestResponse;

export async function fetchTopicInputRequests(topicId: number): Promise<PendingInputRequest[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/input-requests`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load input requests' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchJobInputRequest(jobId: number): Promise<PendingInputRequest> {
  const res = await fetch(`${BASE}/jobs/${jobId}/input-request`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load input request' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function answerInputRequest(requestId: number, payload: { value: boolean | string | string[]; comment?: string }): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/input-requests/${requestId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ error: 'Failed to answer input request' }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function cancelInputRequest(requestId: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/input-requests/${requestId}/cancel`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({ error: 'Failed to cancel input request' }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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

// ── Artifacts ──

export interface ArtifactSummary {
  id: number;
  topic_id: number;
  artifact_class: string;
  kind: string;
  title: string;
  status: string;
  canonical_source: string;
  current_version_id: number | null;
  created_by_agent: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersion {
  id: number;
  artifact_id: number;
  version: number;
  content_type: string;
  body: string;
  summary: string | null;
  created_by_agent: string | null;
  created_at: string;
}

export interface MessageArtifactInfo {
  artifact_id: number;
  artifact_version_id: number;
  relation: string;
  kind: string;
  title: string;
  version: number;
}

export async function fetchTopicArtifacts(topicId: number, scope: 'local' | 'inherited' = 'local'): Promise<ArtifactSummary[]> {
  const res = await fetch(`${BASE}/topics/${topicId}/artifacts?scope=${scope}`);
  return res.json();
}

export async function fetchArtifact(artifactId: number): Promise<ArtifactSummary> {
  const res = await fetch(`${BASE}/artifacts/${artifactId}`);
  return res.json();
}

export async function fetchArtifactVersions(artifactId: number): Promise<ArtifactVersion[]> {
  const res = await fetch(`${BASE}/artifacts/${artifactId}/versions`);
  return res.json();
}

export async function fetchArtifactVersion(artifactId: number, versionId: number): Promise<ArtifactVersion> {
  const res = await fetch(`${BASE}/artifacts/${artifactId}/versions/${versionId}`);
  return res.json();
}

export async function fetchMessageArtifacts(messageId: number): Promise<MessageArtifactInfo[]> {
  const res = await fetch(`${BASE}/messages/${messageId}/artifacts`);
  return res.json();
}

export async function promoteArtifactVersion(artifactId: number, versionId: number, repoPath: string): Promise<{ ok: boolean; repoPath?: string; commitSha?: string; error?: string }> {
  const res = await fetch(`${BASE}/artifacts/${artifactId}/versions/${versionId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath }),
  });
  return res.json();
}

export function artifactDownloadUrl(artifactId: number, versionId: number): string {
  return `${BASE}/artifacts/${artifactId}/versions/${versionId}/download`;
}

// ── Archive ──

export async function apiRenameTopic(topicId: number, name: string): Promise<void> {
  const res = await fetch(`${BASE}/topics/${topicId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to rename topic' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
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

// ── References ──

export interface ReferenceSuggestItem {
  type: 'workspace_file' | 'filesystem_file' | 'workspace_dir' | 'filesystem_dir' | 'artifact_document';
  label: string;
  insertText: string;
  canonicalUri: string;
  description: string;
  continueAutocomplete?: boolean;
}

export type WorkspaceFileResponse =
  | { content: string; mime: string; size: number; binary?: false }
  | { binary: true; mime: string; size: number };

export interface ResolvedReference {
  targetType: 'workspace-file' | 'filesystem-file' | 'artifact-document' | 'artifact-tree-file';
  canonicalUri: string;
  displayName: string;
  mime: string;
  language: string;
  selection: { line: number | null; column: number | null };
  fetch:
    | { kind: 'workspace'; path: string }
    | { kind: 'filesystem'; rootId: string; path: string }
    | { kind: 'artifact-document'; artifactId: number; version?: number };
}

export async function suggestReferences(
  q: string,
  topicId?: number,
  limit = 20,
  scope: 'inherited' | 'global' = 'inherited'
): Promise<{ items: ReferenceSuggestItem[] }> {
  const params = new URLSearchParams({ q, limit: String(limit), scope });
  if (topicId) params.set('topicId', String(topicId));
  const res = await fetch(`${BASE}/references/suggest?${params}`);
  return res.json();
}

export async function resolveReference(href: string): Promise<ResolvedReference> {
  const res = await fetch(`${BASE}/references/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ href }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Resolve failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchFileAtRoot(rootId: string, filePath: string): Promise<WorkspaceFileResponse> {
  const res = await fetch(`${BASE}/fs/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'File not found' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchWorkspaceFile(filePath: string): Promise<WorkspaceFileResponse> {
  return fetchFileAtRoot('workspace', filePath);
}

export function fileDownloadUrl(
  rootId: string,
  filePath: string,
  disposition: 'attachment' | 'inline' = 'attachment'
): string {
  return `${BASE}/fs/download?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(filePath)}&disposition=${disposition}`;
}

export function workspaceDownloadUrl(
  filePath: string,
  disposition: 'attachment' | 'inline' = 'attachment'
): string {
  return fileDownloadUrl('workspace', filePath, disposition);
}
