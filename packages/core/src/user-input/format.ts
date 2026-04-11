import type { JobInputRequestPayload } from './db.js';

export function formatUserInputResults(request: JobInputRequestPayload): string {
  if (!request.response) {
    throw new Error(`Request ${request.requestId} has no response`);
  }

  return JSON.stringify({
    request_id: request.requestId,
    request_key: request.requestKey,
    kind: request.kind,
    answered_by_user_id: request.answeredByUserId,
    answered_by_handle: request.answeredByHandle,
    answered_at: request.answeredAt,
    value: request.response.value,
    comment: request.response.comment,
  }, null, 2);
}
