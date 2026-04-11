import type { ChildProcess } from 'child_process';

export interface SandboxOptions {
  /** Project root to mount read-write inside the sandbox. */
  projectRoot: string;
  /** Mount the project root read-only. */
  readOnlyProject?: boolean;
  /** Whether to provide an empty home directory. */
  emptyHome: boolean;
  /** Whether to provide a private /tmp. */
  privateTmp: boolean;
  /** Environment variables to forward into the sandbox. */
  forwardEnv: string[];
  /** Provider-specific container image for this run (required by the container backend). */
  containerImage?: string;
  /** Command to run inside the container (container backend only). */
  containerCommand?: string;
  /** Host path for the per-job output directory, mounted rw at /teepee-out inside the sandbox. */
  outputDir?: string;
}

/**
 * Abstract sandbox runner.
 * Concrete implementations wrap OS-specific isolation tools.
 */
export abstract class SandboxRunner {
  abstract readonly name: string;

  /** Check if the sandbox backend is available on this system. */
  abstract isAvailable(): boolean;

  /**
   * Spawn a command inside the sandbox.
   * Returns a ChildProcess with stdio pipes.
   */
  abstract spawn(
    command: string,
    args: string[],
    options: SandboxOptions
  ): ChildProcess;
}
