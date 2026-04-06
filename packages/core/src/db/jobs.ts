import type { Database as DatabaseType } from 'better-sqlite3';

export function createBatch(
  db: DatabaseType, triggerMessageId: number, chainRootBatchId: number | null, chainDepth: number
): number {
  const result = db.prepare(
    'INSERT INTO invocation_batches (trigger_message_id, chain_root_batch_id, chain_depth) VALUES (?, ?, ?)'
  ).run(triggerMessageId, chainRootBatchId, chainDepth);
  return Number(result.lastInsertRowid);
}

export function createJob(db: DatabaseType, batchId: number, agentName: string): number {
  const result = db.prepare('INSERT INTO jobs (batch_id, agent_name) VALUES (?, ?)').run(batchId, agentName);
  return Number(result.lastInsertRowid);
}

export function updateJobStatus(
  db: DatabaseType, jobId: number, status: string, extra?: { output_message_id?: number; error?: string }
): void {
  if (status === 'running') {
    db.prepare("UPDATE jobs SET status = ?, started_at = datetime('now') WHERE id = ?").run(status, jobId);
  } else if (status === 'done' || status === 'failed') {
    db.prepare(
      `UPDATE jobs SET status = ?, completed_at = datetime('now'), output_message_id = COALESCE(?, output_message_id), error = COALESCE(?, error) WHERE id = ?`
    ).run(status, extra?.output_message_id ?? null, extra?.error ?? null, jobId);
  } else {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
  }
}

export function getJobsForBatch(
  db: DatabaseType, batchId: number
): Array<{ id: number; agent_name: string; status: string; output_message_id: number | null; error: string | null }> {
  return db.prepare('SELECT id, agent_name, status, output_message_id, error FROM jobs WHERE batch_id = ?').all(batchId) as any;
}

export function countChainJobs(db: DatabaseType, chainRootBatchId: number): number {
  const result = db.prepare(
    `SELECT COUNT(*) as cnt FROM jobs WHERE batch_id IN (SELECT id FROM invocation_batches WHERE chain_root_batch_id = ? OR id = ?)`
  ).get(chainRootBatchId, chainRootBatchId) as any;
  return result.cnt;
}
