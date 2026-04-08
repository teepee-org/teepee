import * as os from 'os';
import { BubblewrapRunner } from './linux-bwrap.js';
import { ContainerSandboxRunner } from './container-runner.js';
import type { SandboxRunner } from './runner.js';

export interface SandboxDetectionResult {
  runner: SandboxRunner;
  available: boolean;
  backend: 'bubblewrap' | 'container' | 'none';
}

/**
 * Detect the available sandbox backend for this platform.
 *
 * If a runner is explicitly configured, only that runner is tried.
 * If it is unavailable, detection returns unavailable — no fallback.
 *
 * If no runner is configured (auto mode):
 * - Linux: try bubblewrap first, then container
 * - macOS/other: try container runtime only
 *
 * If nothing is available, return available=false.
 */
export function detectSandboxAvailability(options?: {
  preferredRunner?: 'bubblewrap' | 'container';
}): SandboxDetectionResult {
  const platform = os.platform();
  const preferred = options?.preferredRunner;

  // Explicit configuration — strict, no fallback
  if (preferred === 'bubblewrap') {
    const bwrap = new BubblewrapRunner();
    return bwrap.isAvailable()
      ? { runner: bwrap, available: true, backend: 'bubblewrap' }
      : { runner: bwrap, available: false, backend: 'none' };
  }

  if (preferred === 'container') {
    const container = new ContainerSandboxRunner();
    return container.isAvailable()
      ? { runner: container, available: true, backend: 'container' }
      : { runner: container, available: false, backend: 'none' };
  }

  // Auto-detect by platform
  if (platform === 'linux') {
    const bwrap = new BubblewrapRunner();
    if (bwrap.isAvailable()) {
      return { runner: bwrap, available: true, backend: 'bubblewrap' };
    }
    const container = new ContainerSandboxRunner();
    if (container.isAvailable()) {
      return { runner: container, available: true, backend: 'container' };
    }
  } else {
    const container = new ContainerSandboxRunner();
    if (container.isAvailable()) {
      return { runner: container, available: true, backend: 'container' };
    }
  }

  // Nothing available
  const fallback = platform === 'linux'
    ? new BubblewrapRunner()
    : new ContainerSandboxRunner();
  return { runner: fallback, available: false, backend: 'none' };
}
