import type { ExecutionMode, AgentCapability, SecurityConfig } from './config.js';
import type { UserRole } from './commands/types.js';

export interface PolicyResult {
  mode: ExecutionMode;
  reason: string;
}

const VALID_MODES = new Set<string>(['host', 'sandbox', 'disabled']);

/**
 * Runtime guard: ensure a mode string is a valid ExecutionMode.
 * Unknown values fail closed to 'disabled' — never to 'host'.
 */
function safeMode(mode: string | undefined): ExecutionMode {
  if (mode && VALID_MODES.has(mode)) return mode as ExecutionMode;
  return 'disabled';
}

/**
 * Resolve the effective execution mode for a job.
 *
 * effective_mode = min(requester_default, agent_capability)
 *
 * Where the ordering is: host > sandbox > disabled.
 * The stricter (lower) of the two wins.
 */
export function resolveExecutionPolicy(
  requesterRole: UserRole,
  agentCapability: AgentCapability | undefined,
  security: SecurityConfig
): PolicyResult {
  const capability = agentCapability ?? 'host_allowed';

  // Agent is disabled entirely
  if (capability === 'disabled') {
    return { mode: 'disabled', reason: 'agent is disabled' };
  }

  // Resolve requester default from role — fail closed on unknown values
  const rawDefault = security.role_defaults[requesterRole];
  const roleDefault = safeMode(rawDefault);

  // If the stored value was invalid, report it
  if (rawDefault !== roleDefault) {
    return { mode: 'disabled', reason: `role '${requesterRole}' has invalid mode '${rawDefault}', failing closed` };
  }

  // Observer is always disabled
  if (roleDefault === 'disabled') {
    return { mode: 'disabled', reason: `role '${requesterRole}' is disabled` };
  }

  // Agent is sandbox_only — always sandbox regardless of requester
  if (capability === 'sandbox_only') {
    return { mode: 'sandbox', reason: 'agent is sandbox_only' };
  }

  // capability === 'host_allowed': follow requester default
  return { mode: roleDefault, reason: `role '${requesterRole}' defaults to '${roleDefault}'` };
}

/**
 * Check whether the resolved mode requires sandboxing and whether
 * the sandbox backend is available. Returns an error string if the
 * run should be blocked, or null if it can proceed.
 */
export function validateSandboxAvailability(
  mode: ExecutionMode,
  sandboxAvailable: boolean
): string | null {
  if (mode === 'sandbox' && !sandboxAvailable) {
    return 'Sandbox required but not available on this platform. Non-owner agent runs are blocked.';
  }
  return null;
}
