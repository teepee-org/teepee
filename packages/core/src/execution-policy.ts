import type { ExecutionMode, AgentAccessProfile } from './config.js';

export interface PolicyResult {
  mode: ExecutionMode;
  reason: string;
  sandboxReadOnly: boolean;
  canWriteArtifacts: boolean;
}

/**
 * Resolve the effective execution mode for a job.
 *
 * Profile-based resolution:
 *   readonly  -> sandbox with read-only codebase mount
 *   readwrite -> sandbox with read-write codebase mount
 *   trusted   -> host read-write, outside the codebase sandbox
 *
 * Role checks happen before this function via roles[role][agent].
 */
export function resolveExecutionPolicy(
  profile: AgentAccessProfile | null | undefined
): PolicyResult {
  if (!profile) {
    return { mode: 'disabled', reason: 'agent is not mapped for the requester role', sandboxReadOnly: false, canWriteArtifacts: false };
  }

  if (profile === 'readonly') {
    return { mode: 'sandbox', reason: "profile 'readonly' uses a read-only codebase sandbox", sandboxReadOnly: true, canWriteArtifacts: false };
  }

  if (profile === 'draft') {
    return { mode: 'sandbox', reason: "profile 'draft' uses a read-only codebase sandbox with artifact write", sandboxReadOnly: true, canWriteArtifacts: true };
  }

  if (profile === 'readwrite') {
    return { mode: 'sandbox', reason: "profile 'readwrite' uses a read-write codebase sandbox", sandboxReadOnly: false, canWriteArtifacts: true };
  }

  if (profile === 'trusted') {
    return { mode: 'host', reason: "profile 'trusted' uses host filesystem access", sandboxReadOnly: false, canWriteArtifacts: true };
  }

  return { mode: 'disabled', reason: `unknown profile '${profile}', failing closed`, sandboxReadOnly: false, canWriteArtifacts: false };
}

export function validateSandboxAvailability(
  mode: ExecutionMode,
  sandboxAvailable: boolean
): string | null {
  if (mode === 'sandbox' && !sandboxAvailable) {
    return 'Sandbox required but not available on this platform. Non-owner agent runs are blocked.';
  }
  return null;
}

/**
 * Single source of truth for fail-closed preflight checks that must run
 * identically at job start and job resume. Returns the first error message, or
 * null when all checks pass. Add future preflights here so both paths stay in
 * sync.
 */
export function validateJobRunPreconditions(params: {
  agentName: string;
  providerName: string;
  effectiveMode: ExecutionMode;
  policyReason: string;
  sandboxAvailable: boolean;
  sandboxRunnerName: string;
  providerSandboxImage: string | undefined;
}): string | null {
  if (params.effectiveMode === 'disabled') {
    return `Agent '${params.agentName}' is disabled: ${params.policyReason}`;
  }

  if (params.effectiveMode === 'sandbox') {
    const availabilityError = validateSandboxAvailability(params.effectiveMode, params.sandboxAvailable);
    if (availabilityError) return availabilityError;

    if (params.sandboxRunnerName === 'container' && !params.providerSandboxImage) {
      return `Sandbox backend 'container' requires provider '${params.providerName}' to define providers.${params.providerName}.sandbox.image`;
    }
  }

  return null;
}
