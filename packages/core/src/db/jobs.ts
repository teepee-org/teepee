import type { Database as DatabaseType } from 'better-sqlite3';

export function createBatch(
  db: DatabaseType, triggerMessageId: number, chainRootBatchId: number | null, chainDepth: number
): number {
  const result = db.prepare(
    'INSERT INTO invocation_batches (trigger_message_id, chain_root_batch_id, chain_depth) VALUES (?, ?, ?)'
  ).run(triggerMessageId, chainRootBatchId, chainDepth);
  return Number(result.lastInsertRowid);
}

export function createJob(
  db: DatabaseType,
  batchId: number,
  agentName: string,
  extra?: {
    requested_by_email?: string | null;
    requested_by_user_id?: string | null;
    effective_mode?: string | null;
    effective_profile?: string | null;
  }
): number {
  const result = db.prepare(
    `INSERT INTO jobs (
       batch_id,
       agent_name,
       requested_by_email,
       requested_by_user_id,
       effective_mode,
       effective_profile
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    batchId,
    agentName,
    extra?.requested_by_email ?? null,
    extra?.requested_by_user_id ?? null,
    extra?.effective_mode ?? null,
    extra?.effective_profile ?? null
  );
  return Number(result.lastInsertRowid);
}

export function updateJobStatus(
  db: DatabaseType,
  jobId: number,
  status: string,
  extra?: {
    output_message_id?: number;
    error?: string;
    requested_by_email?: string;
    requested_by_user_id?: string;
    effective_mode?: string;
    effective_profile?: string | null;
    waiting_request_id?: number | null;
  }
): void {
  if (status === 'running') {
    if (extra?.requested_by_email || extra?.requested_by_user_id || extra?.effective_mode || extra?.effective_profile || extra?.waiting_request_id !== undefined) {
      db.prepare(
        "UPDATE jobs SET status = ?, started_at = COALESCE(started_at, datetime('now')), requested_by_email = COALESCE(?, requested_by_email), requested_by_user_id = COALESCE(?, requested_by_user_id), effective_mode = COALESCE(?, effective_mode), effective_profile = COALESCE(?, effective_profile), waiting_request_id = ? WHERE id = ?"
      ).run(status, extra.requested_by_email ?? null, extra.requested_by_user_id ?? null, extra.effective_mode ?? null, extra.effective_profile ?? null, extra.waiting_request_id ?? null, jobId);
    } else {
      db.prepare("UPDATE jobs SET status = ?, started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(status, jobId);
    }
  } else if (status === 'done' || status === 'failed') {
    db.prepare(
      `UPDATE jobs
       SET status = ?, completed_at = datetime('now'), output_message_id = COALESCE(?, output_message_id), error = COALESCE(?, error),
           requested_by_email = COALESCE(?, requested_by_email), requested_by_user_id = COALESCE(?, requested_by_user_id),
           effective_mode = COALESCE(?, effective_mode), effective_profile = COALESCE(?, effective_profile),
           waiting_request_id = ?
       WHERE id = ?`
    ).run(status, extra?.output_message_id ?? null, extra?.error ?? null, extra?.requested_by_email ?? null, extra?.requested_by_user_id ?? null, extra?.effective_mode ?? null, extra?.effective_profile ?? null, extra?.waiting_request_id ?? null, jobId);
  } else {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
  }
}

export function markJobWaitingInput(db: DatabaseType, jobId: number, requestId: number): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'waiting_input', waiting_request_id = ?, completed_at = NULL
     WHERE id = ?`
  ).run(requestId, jobId);
}

export function markJobResumed(db: DatabaseType, jobId: number): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'running',
         waiting_request_id = NULL,
         last_resumed_at = datetime('now'),
         resume_count = COALESCE(resume_count, 0) + 1,
         completed_at = NULL
     WHERE id = ?`
  ).run(jobId);
}

export function cancelJob(db: DatabaseType, jobId: number, error?: string): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'cancelled',
         error = COALESCE(?, error),
         completed_at = datetime('now'),
         waiting_request_id = NULL
     WHERE id = ?`
  ).run(error ?? null, jobId);
}

export function getJob(db: DatabaseType, jobId: number): any {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

export function getJobsForBatch(
  db: DatabaseType, batchId: number
): Array<{ id: number; agent_name: string; status: string; output_message_id: number | null; error: string | null }> {
  return db.prepare('SELECT id, agent_name, status, output_message_id, error FROM jobs WHERE batch_id = ?').all(batchId) as any;
}

export function listActiveJobsForTopic(
  db: DatabaseType,
  topicId: number
): Array<{ id: number; agent_name: string; status: string; output_message_id: number | null; error: string | null }> {
  return db.prepare(
    `SELECT j.id, j.agent_name, j.status, j.output_message_id, j.error
       FROM jobs j
       JOIN invocation_batches b ON b.id = j.batch_id
       JOIN messages m ON m.id = b.trigger_message_id
      WHERE m.topic_id = ?
        AND j.status IN ('queued', 'running')
      ORDER BY j.id ASC`
  ).all(topicId) as any;
}

export function countActiveJobsByTopic(
  db: DatabaseType
): Map<number, { queued: number; running: number }> {
  const rows = db.prepare(
    `SELECT
       m.topic_id as topic_id,
       SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) as queued_count,
       SUM(CASE WHEN j.status IN ('running', 'waiting_input') THEN 1 ELSE 0 END) as running_count
     FROM jobs j
     JOIN invocation_batches b ON b.id = j.batch_id
     JOIN messages m ON m.id = b.trigger_message_id
     WHERE j.status IN ('queued', 'running', 'waiting_input')
     GROUP BY m.topic_id`
  ).all() as Array<{ topic_id: number; queued_count: number; running_count: number }>;

  return new Map(
    rows.map((row) => [
      row.topic_id,
      {
        queued: Number(row.queued_count ?? 0),
        running: Number(row.running_count ?? 0),
      },
    ])
  );
}

export function failInterruptedJobs(
  db: DatabaseType,
  error: string = 'Server restarted before job completed'
): number {
  const result = db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            error = COALESCE(error, ?),
            completed_at = COALESCE(completed_at, datetime('now')),
            waiting_request_id = NULL
      WHERE status IN ('queued', 'running')`
  ).run(error);
  return Number(result.changes ?? 0);
}

export function countChainJobs(db: DatabaseType, chainRootBatchId: number): number {
  const result = db.prepare(
    `SELECT COUNT(*) as cnt FROM jobs WHERE batch_id IN (SELECT id FROM invocation_batches WHERE chain_root_batch_id = ? OR id = ?)`
  ).get(chainRootBatchId, chainRootBatchId) as any;
  return result.cnt;
}
