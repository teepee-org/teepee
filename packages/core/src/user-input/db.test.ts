import { describe, expect, it } from 'vitest';
import { openDb } from '../db/database.js';
import { createBatch, createJob, getJob, markJobWaitingInput } from '../db/jobs.js';
import { insertMessage } from '../db/messages.js';
import { createTopic } from '../db/topics.js';
import { createUser, activateUser, getUser } from '../db/users.js';
import { createJobInputRequest, expirePendingJobInputRequests, getJobInputRequestById } from './db.js';

describe('expirePendingJobInputRequests', () => {
  it('expires pending requests and fails the waiting job', () => {
    const db = openDb(':memory:');
    createUser(db, 'owner@test.com', 'owner');
    activateUser(db, 'owner@test.com', 'owner');
    const owner = getUser(db, 'owner@test.com');
    expect(owner).toBeTruthy();

    const topicId = createTopic(db, 'demo');
    const messageId = insertMessage(db, topicId, 'user', 'owner', '@coder needs input');
    const batchId = createBatch(db, messageId, null, 0);
    const jobId = createJob(db, batchId, 'coder');

    const request = createJobInputRequest(db, {
      jobId,
      topicId,
      requestedByAgent: 'coder',
      requestedByMessageId: messageId,
      requestedByUserId: owner!.id,
      request: {
        requestKey: 'approval',
        title: 'Approval needed',
        kind: 'confirm',
        prompt: 'Proceed?',
        required: true,
        allowComment: false,
        expiresInSec: 60,
      },
    });

    markJobWaitingInput(db, jobId, request.requestId);

    const changed = expirePendingJobInputRequests(db, '9999-01-01T00:00:00.000Z');

    expect(changed).toEqual([
      { requestId: request.requestId, jobId, topicId, agentName: 'coder' },
    ]);

    expect(getJobInputRequestById(db, request.requestId)?.status).toBe('expired');

    const job = getJob(db, jobId) as {
      status: string;
      error: string | null;
      waiting_request_id: number | null;
      completed_at: string | null;
    };
    expect(job.status).toBe('failed');
    expect(job.error).toBe('User input request expired before answer');
    expect(job.waiting_request_id).toBeNull();
    expect(job.completed_at).toBeTruthy();
  });
});
