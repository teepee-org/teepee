import * as http from 'http';
import type { TeepeeConfig, SessionUser } from 'teepee-core';
import { getSession } from 'teepee-core';
import type { Database as DatabaseType } from 'better-sqlite3';

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = v.join('=');
  }
  return cookies;
}

export function getSessionFromReq(db: DatabaseType, req: http.IncomingMessage): SessionUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['teepee_session'];
  if (!sid) return null;
  return getSession(db, sid);
}

export function authenticateRequest(db: DatabaseType, req: http.IncomingMessage): SessionUser | null {
  return getSessionFromReq(db, req);
}

export function getClientIp(config: TeepeeConfig, req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (config.server.trust_proxy && forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || '';
}

export function isBehindHttps(config: TeepeeConfig, req: http.IncomingMessage): boolean {
  return config.server.trust_proxy && req.headers['x-forwarded-proto'] === 'https';
}

export function getRequestHost(config: TeepeeConfig, req: http.IncomingMessage, port: number): string {
  if (config.server.trust_proxy && typeof req.headers['x-forwarded-host'] === 'string') {
    return req.headers['x-forwarded-host'];
  }
  return req.headers.host || `localhost:${port}`;
}

export function jsonResponse(res: http.ServerResponse, data: object, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

export function setSessionCookie(
  config: TeepeeConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string
) {
  const maxAge = 30 * 24 * 60 * 60;
  const https = isBehindHttps(config, req);
  // SameSite=None requires Secure; only use it when both HTTPS and an explicit
  // cross-origin allowlist are configured. Otherwise fall back to Lax.
  const crossOrigin = https && config.server.cors_allowed_origins.length > 0;
  const sameSite = crossOrigin ? 'None' : 'Lax';
  const secure = https ? '; Secure' : '';
  res.setHeader('Set-Cookie', `teepee_session=${sessionId}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`);
}

// ── CORS ──

export function getRequestOrigin(config: TeepeeConfig, req: http.IncomingMessage, port: number): string {
  return `${isBehindHttps(config, req) ? 'https' : 'http'}://${getRequestHost(config, req, port)}`;
}

export function applyCors(config: TeepeeConfig, req: http.IncomingMessage, res: http.ServerResponse, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const sameOrigin = origin === getRequestOrigin(config, req, port);
  const allowlisted = config.server.cors_allowed_origins.includes(origin);
  if (!sameOrigin && !allowlisted) return false;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cookie auth requires Allow-Credentials on cross-origin responses. Skip on
  // same-origin where the header is unnecessary and could surprise operators.
  if (!sameOrigin && allowlisted) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return true;
}

// ── Rate limit ──

interface RateLimitEntry { count: number; resetAt: number; }
const authRateLimits = new Map<string, RateLimitEntry>();

export function rateLimitAuth(
  config: TeepeeConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bucket: string
): boolean {
  const windowMs = config.server.auth_rate_limit_window_seconds * 1000;
  const maxRequests = config.server.auth_rate_limit_max_requests;
  if (maxRequests <= 0) return true;
  const key = `${bucket}:${getClientIp(config, req)}`;
  const now = Date.now();
  const existing = authRateLimits.get(key);
  if (!existing || existing.resetAt <= now) {
    authRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= maxRequests) {
    res.setHeader('Retry-After', String(config.server.auth_rate_limit_window_seconds));
    jsonResponse(res, { error: 'Too many auth attempts. Try again later.' }, 429);
    return false;
  }
  existing.count += 1;
  return true;
}
