import type { Database as DatabaseType } from 'better-sqlite3';
import type { NormalizedUserInputResponse, UserInputKind, UserInputOption, ValidatedUserInputRequest } from './manifest.js';
import { parseStoredUserInputRequestForm } from './manifest.js';

export interface JobInputRequestRow {
  id: number;
  job_id: number;
  topic_id: number;
  requested_by_agent: string;
  requested_by_message_id: number | null;
  requested_by_user_id: string;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  request_key: string;
  title: string;
  kind: UserInputKind;
  prompt: string;
  form_json: string;
  response_json: string | null;
  answered_by_user_id: string | null;
  answered_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobInputRequestPayload {
  requestId: number;
  jobId: number;
  topicId: number;
  agentName: string;
  requestedByUserId: string;
  requestedByHandle: string | null;
  requestedByMessageId: number | null;
  requestKey: string;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  title: string;
  kind: UserInputKind;
  prompt: string;
  required: boolean;
  options?: UserInputOption[];
  allowComment: boolean;
  response?: NormalizedUserInputResponse;
  answeredByUserId: string | null;
  answeredByHandle: string | null;
  answeredAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createJobInputRequest(
  db: DatabaseType,
  params: {
    jobId: number;
    topicId: number;
    requestedByAgent: string;
    requestedByMessageId: number | null;
    requestedByUserId: string;
    request: ValidatedUserInputRequest;
  }
): JobInputRequestPayload {
  const formJson = JSON.stringify(toStoredRequest(params.request));
  const expiresAt = params.request.expiresInSec
    ? new Date(Date.now() + params.request.expiresInSec * 1000).toISOString()
    : null;

  const result = db.prepare(
    `INSERT INTO job_input_requests (
      job_id, topic_id, requested_by_agent, requested_by_message_id, requested_by_user_id,
      status, request_key, title, kind, prompt, form_json, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  ).run(
    params.jobId,
    params.topicId,
    params.requestedByAgent,
    params.requestedByMessageId,
    params.requestedByUserId,
    params.request.requestKey,
    params.request.title,
    params.request.kind,
    params.request.prompt,
    formJson,
    expiresAt
  );

  const row = db.prepare('SELECT * FROM job_input_requests WHERE id = ?').get(Number(result.lastInsertRowid)) as JobInputRequestRow;
  return hydrateJobInputRequestPayload(db, row);
}

export function getJobInputRequestById(db: DatabaseType, requestId: number): JobInputRequestPayload | undefined {
  const row = db.prepare('SELECT * FROM job_input_requests WHERE id = ?').get(requestId) as JobInputRequestRow | undefined;
  return row ? hydrateJobInputRequestPayload(db, row) : undefined;
}

export function getPendingJobInputRequest(db: DatabaseType, jobId: number): JobInputRequestPayload | undefined {
  const row = db.prepare(
    `SELECT * FROM job_input_requests WHERE job_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`
  ).get(jobId) as JobInputRequestRow | undefined;
  return row ? hydrateJobInputRequestPayload(db, row) : undefined;
}

export function listPendingTopicInputRequests(db: DatabaseType, topicId: number): JobInputRequestPayload[] {
  const rows = db.prepare(
    `SELECT * FROM job_input_requests WHERE topic_id = ? AND status = 'pending' ORDER BY created_at, id`
  ).all(topicId) as JobInputRequestRow[];
  return rows.map((row) => hydrateJobInputRequestPayload(db, row));
}

export function listVisibleTopicInputRequests(db: DatabaseType, topicId: number): JobInputRequestPayload[] {
  const rows = db.prepare(
    `SELECT * FROM job_input_requests
     WHERE topic_id = ? AND status IN ('pending', 'answered', 'cancelled', 'expired')
     ORDER BY created_at, id`
  ).all(topicId) as JobInputRequestRow[];
  return rows.map((row) => hydrateJobInputRequestPayload(db, row));
}

export function answerJobInputRequest(
  db: DatabaseType,
  requestId: number,
  answeredByUserId: string,
  response: NormalizedUserInputResponse
): boolean {
  const result = db.prepare(
    `UPDATE job_input_requests
     SET status = 'answered',
         response_json = ?,
         answered_by_user_id = ?,
         answered_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  ).run(JSON.stringify(response), answeredByUserId, requestId);
  return result.changes > 0;
}

export function cancelJobInputRequest(db: DatabaseType, requestId: number): boolean {
  const result = db.prepare(
    `UPDATE job_input_requests
     SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  ).run(requestId);
  return result.changes > 0;
}

export function expirePendingJobInputRequests(
  db: DatabaseType,
  nowIso: string = new Date().toISOString()
): Array<{ requestId: number; jobId: number; topicId: number; agentName: string }> {
  const rows = db.prepare(
    `SELECT r.id, r.job_id, r.topic_id, j.agent_name
     FROM job_input_requests r
     JOIN jobs j ON j.id = r.job_id
     WHERE r.status = 'pending' AND r.expires_at IS NOT NULL AND r.expires_at < ?`
  ).all(nowIso) as Array<{ id: number; job_id: number; topic_id: number; agent_name: string }>;

  const markExpired = db.prepare(
    `UPDATE job_input_requests SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
  );

  const failJob = db.prepare(
    `UPDATE jobs
     SET status = 'failed',
         error = 'User input request expired before answer',
         completed_at = datetime('now'),
         waiting_request_id = NULL
     WHERE id = ? AND status = 'waiting_input'`
  );

  const changed: Array<{ requestId: number; jobId: number; topicId: number; agentName: string }> = [];
  const txn = db.transaction(() => {
    for (const row of rows) {
      const updated = markExpired.run(row.id);
      if (updated.changes > 0) {
        failJob.run(row.job_id);
        changed.push({ requestId: row.id, jobId: row.job_id, topicId: row.topic_id, agentName: row.agent_name });
      }
    }
  });
  txn();
  return changed;
}

function hydrateJobInputRequestPayload(db: DatabaseType, row: JobInputRequestRow): JobInputRequestPayload {
  const form = parseStoredUserInputRequestForm(row.form_json);
  const requestedBy = db.prepare('SELECT handle FROM users WHERE id = ?').get(row.requested_by_user_id) as { handle: string | null } | undefined;
  const answeredBy = row.answered_by_user_id
    ? db.prepare('SELECT handle FROM users WHERE id = ?').get(row.answered_by_user_id) as { handle: string | null } | undefined
    : undefined;

  return {
    requestId: row.id,
    jobId: row.job_id,
    topicId: row.topic_id,
    agentName: row.requested_by_agent,
    requestedByUserId: row.requested_by_user_id,
    requestedByHandle: requestedBy?.handle ?? null,
    requestedByMessageId: row.requested_by_message_id,
    requestKey: row.request_key,
    status: row.status,
    title: row.title,
    kind: row.kind,
    prompt: row.prompt,
    required: form.required,
    options: form.options,
    allowComment: form.allowComment,
    response: row.response_json ? JSON.parse(row.response_json) as NormalizedUserInputResponse : undefined,
    answeredByUserId: row.answered_by_user_id,
    answeredByHandle: answeredBy?.handle ?? null,
    answeredAt: row.answered_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredRequest(request: ValidatedUserInputRequest): Record<string, unknown> {
  return {
    request_key: request.requestKey,
    title: request.title,
    kind: request.kind,
    prompt: request.prompt,
    required: request.required,
    allow_comment: request.allowComment,
    options: request.options,
    expires_in_sec: request.expiresInSec,
  };
}
