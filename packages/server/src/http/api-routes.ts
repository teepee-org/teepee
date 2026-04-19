import * as http from 'http';
import type { SessionUser } from 'teepee-core';
import type { ServerContext } from '../context.js';
import { buildApiRouteContext } from './api/context.js';
import { handleAdminRoutes } from './api/admin.js';
import { handleApplicationRoutes } from './api/application.js';
import { handleTopicManagementRoutes } from './api/topic-management.js';
import { handleArtifactRoutes } from './api/artifacts.js';
import { handleJobInputRoutes } from './api/job-input.js';
import { handleReferenceRoutes } from './api/references.js';
import { handleFilesystemRoutes } from './api/filesystem.js';

/**
 * Handle /api/* routes. Returns true if matched.
 * Caller must ensure `currentUser` is authenticated.
 */
export function handleApiRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  currentUser: SessionUser
): boolean {
  const routeCtx = buildApiRouteContext(ctx, req, res, url, currentUser);
  if (handleAdminRoutes(routeCtx)) return true;
  if (handleApplicationRoutes(routeCtx)) return true;
  if (handleTopicManagementRoutes(routeCtx)) return true;
  if (handleArtifactRoutes(routeCtx)) return true;
  if (handleJobInputRoutes(routeCtx)) return true;
  if (handleReferenceRoutes(routeCtx)) return true;
  if (handleFilesystemRoutes(routeCtx)) return true;
  return false;
}
