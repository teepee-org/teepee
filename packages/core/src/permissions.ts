import type { Database as DatabaseType } from 'better-sqlite3';
import { getUser, getPermissions, countRecentJobs } from './db.js';
import type { LimitsConfig } from './config.js';

/**
 * Check if a user can tag a specific agent, optionally scoped to a topic.
 *
 * Rules (deny-by-default, deny wins):
 * 1. owner → always allowed
 * 2. observer → always denied
 * 3. any matching deny (topic or global) → denied
 * 4. any matching allow (topic or global) → allowed
 * 5. no rule → denied
 */
export function canTag(
  db: DatabaseType,
  email: string,
  agentName: string,
  topicId: number | null
): boolean {
  const user = getUser(db, email);
  if (!user || user.status !== 'active') return false;

  // Owner always allowed
  if (user.role === 'owner') return true;

  // Observer never allowed
  if (user.role === 'observer') return false;

  const perms = getPermissions(db, email, topicId);

  // Check deny first — any matching deny blocks
  for (const p of perms) {
    if (!p.allowed) {
      if (p.target_agent === '*' || p.target_agent === agentName) {
        return false;
      }
    }
  }

  // Check allow
  for (const p of perms) {
    if (p.allowed) {
      if (p.target_agent === '*' || p.target_agent === agentName) {
        return true;
      }
    }
  }

  // Default: denied
  return false;
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
  limits: LimitsConfig
): { allowed: string[]; denied: string[]; rateLimited: boolean } {
  if (!checkRateLimit(db, email, limits)) {
    return { allowed: [], denied: agentNames, rateLimited: true };
  }

  const allowed: string[] = [];
  const denied: string[] = [];

  for (const agent of agentNames) {
    if (canTag(db, email, agent, topicId)) {
      allowed.push(agent);
    } else {
      denied.push(agent);
    }
  }

  return { allowed, denied, rateLimited: false };
}
