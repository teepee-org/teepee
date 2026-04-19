import {
  expirePendingJobInputRequests,
  getPendingJobInputRequest,
  listVisibleTopicInputRequests,
} from 'teepee-core';
import { readBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

export function handleJobInputRoutes(routeCtx: ApiRouteContext): boolean {
  const { ctx, req, url, currentUser, json } = routeCtx;

  if (url.pathname.match(/^\/api\/topics\/\d+\/input-requests$/) && req.method === 'GET') {
    expirePendingJobInputRequests(ctx.db);
    const topicId = parseInt(url.pathname.split('/')[3]);
    json(listVisibleTopicInputRequests(ctx.db, topicId));
    return true;
  }

  if (url.pathname.match(/^\/api\/jobs\/\d+\/input-request$/) && req.method === 'GET') {
    expirePendingJobInputRequests(ctx.db);
    const jobId = parseInt(url.pathname.split('/')[3]);
    const request = getPendingJobInputRequest(ctx.db, jobId);
    if (!request) {
      json({ error: 'Input request not found' }, 404);
      return true;
    }
    json(request);
    return true;
  }

  if (url.pathname.match(/^\/api\/input-requests\/\d+\/answer$/) && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        expirePendingJobInputRequests(ctx.db);
        const requestId = parseInt(url.pathname.split('/')[3]);
        const payload = JSON.parse(body);
        const resumed = await ctx.orchestrator.resumeJobFromUserInput(requestId, currentUser.id, payload);
        ctx.broadcast(resumed.topicId, {
          type: 'job.input.answered',
          topicId: resumed.topicId,
          jobId: resumed.jobId,
          requestId: resumed.requestId,
        });
        json({ ok: true });
      } catch (e: any) {
        const message = e?.message || String(e);
        const status =
          message.includes('not found') ? 404
            : message.includes('not pending') || message.includes('no longer pending') ? 409
            : message.includes('Only the user who started') ? 403
            : 400;
        json({ error: message }, status);
      }
    });
    return true;
  }

  if (url.pathname.match(/^\/api\/input-requests\/\d+\/cancel$/) && req.method === 'POST') {
    readBody(req).then(async () => {
      try {
        expirePendingJobInputRequests(ctx.db);
        const requestId = parseInt(url.pathname.split('/')[3]);
        const cancelled = await ctx.orchestrator.cancelJobFromUserInput(requestId, currentUser.id, currentUser.role);
        ctx.broadcast(cancelled.topicId, {
          type: 'job.input.cancelled',
          topicId: cancelled.topicId,
          jobId: cancelled.jobId,
          requestId,
        });
        json({ ok: true });
      } catch (e: any) {
        const message = e?.message || String(e);
        const status =
          message.includes('not found') ? 404
            : message.includes('not pending') || message.includes('no longer pending') ? 409
            : message.includes('Only the requester or an owner') ? 403
            : 400;
        json({ error: message }, status);
      }
    });
    return true;
  }

  return false;
}
