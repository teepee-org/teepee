import type { Database as DatabaseType } from 'better-sqlite3';
import { getUser, countRecentJobs } from './db.js';
import { resolveRoleAgentProfile } from './config.js';
import type { LimitsConfig, TeepeeConfig, AgentAccessProfile, UserRole } from './config.js';

/**
 * Check if a user can tag a specific agent, optionally scoped to a topic.
 *
 * Rules (deny-by-default, deny wins):
 * 1. user must exist and be active
 * 2. user.role is normalized to the built-in roles
 * 3. roles[role][agent] grants the effective profile
 * 4. missing role or missing agent mapping denies access
 */
export function canTag(
  db: DatabaseType,
  email: string,
  agentName: string,
  _topicId: number | null,
  config: TeepeeConfig
): boolean {
  return resolveUserAgentProfile(db, email, agentName, config) !== null;
}

export function resolveUserAgentProfile(
  db: DatabaseType,
  email: string,
  agentName: string,
  config: TeepeeConfig
): AgentAccessProfile | null {
  const user = getUser(db, email);
  if (!user || user.status !== 'active') return null;

  const role = normalizeRoleForAccess(user.role);
  if (!role) return null;

  return resolveRoleAgentProfile(config, role, agentName);
}

function normalizeRoleForAccess(role: string): UserRole | null {
  if (role === 'user') return 'collaborator';
  if (role === 'owner' || role === 'collaborator' || role === 'observer') return role;
  return null;
}

/**
 * Check rate limit for a user.
 */
export function checkRateLimit(
  db: DatabaseType,
  email: string,
  limits: LimitsConfig
): boolean {
  const count = countRecentJobs(db, email, 60);
  return count < limits.max_jobs_per_user_per_minute;
}

/**
 * Filter a list of agent names by permission and rate limit.
 * Returns only the agents the user is allowed to tag.
 */
export function filterAllowedAgents(
  db: DatabaseType,
  email: string,
  agentNames: string[],
  topicId: number,
  limits: LimitsConfig,
  config: TeepeeConfig
): { allowed: string[]; denied: string[]; rateLimited: boolean; profiles: Record<string, AgentAccessProfile> } {
  if (!checkRateLimit(db, email, limits)) {
    return { allowed: [], denied: agentNames, rateLimited: true, profiles: {} };
  }

  const allowed: string[] = [];
  const denied: string[] = [];
  const profiles: Record<string, AgentAccessProfile> = {};

  for (const agent of agentNames) {
    const profile = resolveUserAgentProfile(db, email, agent, config);
    if (profile) {
      allowed.push(agent);
      profiles[agent] = profile;
    } else {
      denied.push(agent);
    }
  }

  return { allowed, denied, rateLimited: false, profiles };
}
