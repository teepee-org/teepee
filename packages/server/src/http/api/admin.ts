import {
  CAPABILITIES,
  createInviteToken,
  createUser,
  deleteUserPermanently,
  demoteFromOwner,
  getUser,
  listRoleCapabilities,
  promoteToOwner,
  reEnableUser,
  revokeUserFull,
  setUserRole,
} from 'teepee-core';
import type { AccessMatrixResponse } from 'teepee-core';
import { getRequestHost, isBehindHttps, readBody } from '../utils.js';
import type { ApiRouteContext } from './context.js';

export function handleAdminRoutes(routeCtx: ApiRouteContext): boolean {
  const {
    ctx,
    req,
    url,
    currentUser,
    json,
    roleHas,
    requireCapability,
    configuredRoles,
    assignableRoles,
  } = routeCtx;

  if (url.pathname === '/api/admin/invite' && req.method === 'POST') {
    if (!requireCapability('users.invite')) return true;
    if (ctx.config.mode !== 'shared') { json({ error: 'Invites are only available in shared mode' }, 403); return true; }
    readBody(req).then((body) => {
      try {
        const { email, role: rawRole } = JSON.parse(body);
        const fallbackRole = assignableRoles.includes('collaborator')
          ? 'collaborator'
          : assignableRoles[0];
        const role = rawRole === 'user' ? 'collaborator' : (rawRole || fallbackRole);
        if (!role || !assignableRoles.includes(role)) {
          json({ error: `Invalid invite role: ${role}. Use one of: ${assignableRoles.join(', ')}` }, 400);
          return;
        }
        try { createUser(ctx.db, email, role); } catch { /* already exists */ }
        const token = createInviteToken(ctx.db, email);
        const { networkInterfaces } = require('os');
        const nets = networkInterfaces();
        let publicIp = 'localhost';
        for (const name of Object.keys(nets)) {
          for (const net of (nets[name] || [])) {
            if (net.family === 'IPv4' && !net.internal) { publicIp = net.address; break; }
          }
          if (publicIp !== 'localhost') break;
        }
        const host = req.headers.host ? getRequestHost(ctx.config, req, ctx.port) : `${publicIp}:${ctx.port}`;
        const link = `${isBehindHttps(ctx.config, req) ? 'https' : 'http'}://${host}/invite/${token}`;
        json({ link, token });
      } catch (e: any) {
        json({ error: e.message }, 400);
      }
    });
    return true;
  }

  if (url.pathname === '/api/admin/revoke' && req.method === 'POST') {
    if (!requireCapability('users.revoke')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = revokeUserFull(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot revoke: user not found, already revoked, or is the last active owner' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/re-enable' && req.method === 'POST') {
    if (!requireCapability('users.reenable')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = reEnableUser(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot re-enable: user not found or not revoked' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/delete' && req.method === 'POST') {
    if (!requireCapability('users.delete')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const ok = deleteUserPermanently(ctx.db, email);
        if (ok) { json({ ok: true }); } else { json({ error: 'Cannot delete: user not found or is the last active owner' }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/role' && req.method === 'POST') {
    if (!requireCapability('users.role.set')) return true;
    readBody(req).then((body) => {
      try {
        const { email, role: rawRole } = JSON.parse(body);
        const role = rawRole === 'user' ? 'collaborator' : rawRole;
        if (!role || !configuredRoles.includes(role)) {
          json({ error: `Invalid role: ${role}. Use one of: ${configuredRoles.join(', ')}` }, 400);
          return;
        }
        const targetUser = getUser(ctx.db, email);
        if (!targetUser) {
          json({ error: 'User not found' }, 404);
          return;
        }
        if (role === 'owner' && !roleHas('users.owner.promote')) {
          json({ error: 'Insufficient permissions' }, 403);
          return;
        }
        if (targetUser.role === 'owner' && role !== 'owner' && !roleHas('users.owner.demote')) {
          json({ error: 'Insufficient permissions' }, 403);
          return;
        }
        const result = setUserRole(ctx.db, email, role, currentUser.email);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/access-matrix' && req.method === 'GET') {
    if (!requireCapability('admin.view')) return true;
    const response: AccessMatrixResponse = {
      roles: configuredRoles,
      assignable_roles: assignableRoles,
      profiles: ['deny', 'readonly', 'draft', 'readwrite', 'trusted'],
      capabilities: [...CAPABILITIES],
      agents: Object.entries(ctx.config.agents).map(([name, a]) => ({ name, provider: a.provider })),
      matrix: Object.fromEntries(configuredRoles.map((role) => [role, ctx.config.roles[role]?.agents ?? {}])),
      role_capabilities: Object.fromEntries(configuredRoles.map((role) => [role, listRoleCapabilities(ctx.config, role)])),
      mode: ctx.config.mode,
      source: '.teepee/config.yaml',
      editable: false,
    };
    json(response);
    return true;
  }

  if (url.pathname === '/api/admin/promote' && req.method === 'POST') {
    if (!requireCapability('users.owner.promote')) return true;
    readBody(req).then((body) => {
      try {
        const { email } = JSON.parse(body);
        const result = promoteToOwner(ctx.db, email, currentUser.email);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  if (url.pathname === '/api/admin/demote' && req.method === 'POST') {
    if (!requireCapability('users.owner.demote')) return true;
    readBody(req).then((body) => {
      try {
        const { email, role } = JSON.parse(body);
        const fallbackRole = assignableRoles.includes('collaborator')
          ? 'collaborator'
          : assignableRoles[0];
        const targetRole = role || fallbackRole;
        if (!targetRole || !assignableRoles.includes(targetRole)) {
          json({ error: `Invalid demotion role: ${targetRole}. Use one of: ${assignableRoles.join(', ')}` }, 400);
          return;
        }
        const result = demoteFromOwner(ctx.db, email, currentUser.email, targetRole);
        if (result.ok) { json({ ok: true }); } else { json({ error: result.error }, 400); }
      } catch (e: any) { json({ error: e.message }, 400); }
    });
    return true;
  }

  return false;
}
