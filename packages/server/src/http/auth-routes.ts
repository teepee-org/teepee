import * as http from 'http';
import {
  createSession,
  validateToken,
  acceptInvite,
  deleteSession,
} from 'teepee-core';
import type { ServerContext } from '../context.js';
import {
  parseCookies,
  authenticateRequest,
  getClientIp,
  jsonResponse,
  readBody,
  setSessionCookie,
  rateLimitAuth,
} from './utils.js';

/**
 * Handle auth routes. Returns true if the route was matched and handled.
 */
export function handleAuthRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const json = (data: object, status = 200) => jsonResponse(res, data, status);

  // GET /auth/owner/:secret
  if (url.pathname.match(/^\/auth\/owner\/[a-f0-9]+$/) && req.method === 'GET') {
    if (!rateLimitAuth(ctx.config, req, res, 'owner')) return true;
    const secret = url.pathname.split('/')[3];
    if (secret === ctx.ownerSecret) {
      const sid = createSession(ctx.db, ctx.ownerEmail, 30, req.headers['user-agent'], getClientIp(ctx.config, req));
      setSessionCookie(ctx.config, req, res, sid);
      res.writeHead(302, { Location: '/' });
      res.end();
    } else {
      json({ error: 'Invalid owner secret' }, 403);
    }
    return true;
  }

  // GET /auth/session
  if (url.pathname === '/auth/session' && req.method === 'GET') {
    const user = authenticateRequest(ctx.db, req);
    if (user) {
      json({ email: user.email, handle: user.handle, role: user.role });
    } else {
      json({ error: 'Not authenticated' }, 401);
    }
    return true;
  }

  // GET /auth/invite/:token
  if (url.pathname.match(/^\/auth\/invite\/[a-f0-9]+$/) && req.method === 'GET') {
    if (!rateLimitAuth(ctx.config, req, res, 'invite:validate')) return true;
    const token = url.pathname.split('/')[3];
    const result = validateToken(ctx.db, token);
    if (result.valid) {
      json({ valid: true, email: result.email });
    } else {
      json({ valid: false, error: result.error }, 400);
    }
    return true;
  }

  // POST /auth/invite/accept
  if (url.pathname === '/auth/invite/accept' && req.method === 'POST') {
    if (!rateLimitAuth(ctx.config, req, res, 'invite:accept')) return true;
    readBody(req).then((body) => {
      try {
        const { token, handle } = JSON.parse(body);
        const result = acceptInvite(ctx.db, token, handle, undefined,
          req.headers['user-agent'], getClientIp(ctx.config, req));
        if (result.ok) {
          setSessionCookie(ctx.config, req, res, result.sessionId!);
          json({ email: result.user?.email, handle: result.user?.handle, role: result.user?.role });
        } else {
          json({ error: result.error }, 400);
        }
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /auth/logout
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['teepee_session'];
    if (sid) deleteSession(ctx.db, sid);
    res.setHeader('Set-Cookie', 'teepee_session=; Path=/; HttpOnly; Max-Age=0');
    json({ ok: true });
    return true;
  }

  return false;
}
