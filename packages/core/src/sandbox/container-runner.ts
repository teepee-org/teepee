import { spawn as nodeSpawn, execFileSync, type ChildProcess } from 'child_process';
import { SandboxRunner, type SandboxOptions } from './runner.js';
import { prepareCommandParts } from '../command.js';

/**
 * Container-based sandbox runner (macOS / cross-platform).
 *
 * Uses a Docker-compatible CLI (docker, podman, orbstack, colima docker)
 * to run provider commands inside an isolated container.
 *
 * Mount layout inside the container:
 *   /workspace   -> project root (rw)
 *   /tmp         -> private (ephemeral)
 *   /home/agent  -> empty (ephemeral)
 *   No parent directories or host home mounted.
 */
export class ContainerSandboxRunner extends SandboxRunner {
  readonly name = 'container';

  private runtime: string | null = null;
  private available: boolean | null = null;

  /**
   * Detect which container runtime is available.
   * Tries docker first, then podman.
   */
  isAvailable(): boolean {
    if (this.available !== null) return this.available;

    for (const rt of ['docker', 'podman']) {
      try {
        execFileSync(rt, ['info'], { stdio: 'pipe', timeout: 10_000 });
        this.runtime = rt;
        this.available = true;
        return true;
      } catch {
        // Try next runtime
      }
    }

    this.available = false;
    return false;
  }

  /** Return the detected runtime name, or null if unavailable. */
  getRuntime(): string | null {
    if (this.available === null) this.isAvailable();
    return this.runtime;
  }

  spawn(command: string, args: string[], options: SandboxOptions): ChildProcess {
    if (!this.isAvailable() || !this.runtime) {
      throw new Error('No container runtime (docker/podman) is available');
    }

    if (!options.containerImage) {
      throw new Error('Container sandbox requires a provider-specific sandbox.image');
    }

    const image = options.containerImage;
    const commandParts = options.containerCommand
      ? prepareCommandParts(options.containerCommand)
      : [command, ...args];

    const runArgs: string[] = [
      'run',
      '--rm',
      '-i',
      // Do not inherit host env — start clean
      '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '--env', 'LANG=C.UTF-8',
      '--env', 'TERM=dumb',
    ];

    // Forward only explicitly listed env vars
    for (const key of options.forwardEnv) {
      if (process.env[key] !== undefined) {
        runArgs.push('--env', `${key}=${process.env[key]}`);
      }
    }

    // Mount project root at /workspace. readonly profile uses a read-only volume.
    runArgs.push('-v', `${options.projectRoot}:/workspace${options.readOnlyProject ? ':ro' : ''}`);
    runArgs.push('-w', '/workspace');

    // Per-job output directory (rw)
    if (options.outputDir) {
      runArgs.push('-v', `${options.outputDir}:/teepee-out`);
      runArgs.push('--env', 'TEEPEE_OUTPUT_DIR=/teepee-out');
    }

    // Empty home
    if (options.emptyHome) {
      runArgs.push('--tmpfs', '/home/agent:rw,noexec,nosuid,size=64m');
      runArgs.push('--env', 'HOME=/home/agent');
    }

    // Private tmp
    if (options.privateTmp) {
      runArgs.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=256m');
    }

    // Security: no privilege escalation
    runArgs.push('--security-opt', 'no-new-privileges');

    // Image — required for the container backend
    runArgs.push(image);

    // Command — provider-specific command, preserving quoted args.
    runArgs.push(...commandParts);

    return nodeSpawn(this.runtime, runArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
  }
}
