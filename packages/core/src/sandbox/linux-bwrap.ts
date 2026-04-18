import { spawn as nodeSpawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SandboxRunner, type SandboxOptions } from './runner.js';

/**
 * Linux sandbox using bubblewrap (bwrap).
 *
 * Mounts:
 *   - project root at /workspace (rw)
 *   - private /tmp (if privateTmp)
 *   - empty /home/agent (if emptyHome)
 *   - /usr, /bin, /lib, /lib64, /etc/resolv.conf read-only for basic operation
 *   - /dev minimal (null, zero, urandom)
 *   - /proc
 *
 * Does NOT mount parent directories or the real home.
 */
export class BubblewrapRunner extends SandboxRunner {
  readonly name = 'bubblewrap';

  private available: boolean | null = null;

  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    try {
      execFileSync('bwrap', ['--version'], { stdio: 'pipe' });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  spawn(command: string, args: string[], options: SandboxOptions): ChildProcess {
    if (!this.isAvailable()) {
      throw new Error('bubblewrap (bwrap) is not installed');
    }

    const bwrapArgs: string[] = [];

    // Minimal root filesystem (read-only)
    for (const dir of ['/usr', '/bin', '/sbin', '/lib']) {
      if (fs.existsSync(dir)) {
        bwrapArgs.push('--ro-bind', dir, dir);
      }
    }
    // lib64 may not exist on all distros
    if (fs.existsSync('/lib64')) {
      bwrapArgs.push('--ro-bind', '/lib64', '/lib64');
    }
    // DNS resolution
    if (fs.existsSync('/etc/resolv.conf')) {
      bwrapArgs.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
    }
    // Basic user/group resolution for runtimes that call getpwuid()/getgrgid()
    if (fs.existsSync('/etc/passwd')) {
      bwrapArgs.push('--ro-bind', '/etc/passwd', '/etc/passwd');
    }
    if (fs.existsSync('/etc/group')) {
      bwrapArgs.push('--ro-bind', '/etc/group', '/etc/group');
    }
    // SSL certs
    if (fs.existsSync('/etc/ssl')) {
      bwrapArgs.push('--ro-bind', '/etc/ssl', '/etc/ssl');
    }
    if (fs.existsSync('/etc/ca-certificates')) {
      bwrapArgs.push('--ro-bind', '/etc/ca-certificates', '/etc/ca-certificates');
    }

    // /proc
    bwrapArgs.push('--proc', '/proc');

    // Minimal /dev
    bwrapArgs.push('--dev', '/dev');

    // Project root at /workspace. readonly profile uses a read-only bind.
    bwrapArgs.push(options.readOnlyProject ? '--ro-bind' : '--bind', options.projectRoot, '/workspace');

    // Per-job output directory (rw)
    if (options.outputDir) {
      bwrapArgs.push('--bind', options.outputDir, '/teepee-out');
    }

    // Private tmp
    if (options.privateTmp) {
      bwrapArgs.push('--tmpfs', '/tmp');
    }

    // Empty home
    if (options.emptyHome) {
      bwrapArgs.push('--tmpfs', '/home/agent');
    }

    // Extra read-only mounts for provider CLIs installed outside the default sandbox-visible paths.
    for (const extraPath of options.extraReadOnlyPaths ?? []) {
      for (const dirToCreate of buildParentDirs(extraPath)) {
        bwrapArgs.push('--dir', dirToCreate);
      }
      bwrapArgs.push('--ro-bind', extraPath, extraPath);
    }

    // Mount provider auth/config state after /home/agent is created, otherwise tmpfs would hide them.
    for (const mount of options.extraMounts ?? []) {
      for (const dirToCreate of buildParentDirs(mount.target)) {
        bwrapArgs.push('--dir', dirToCreate);
      }
      bwrapArgs.push(mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.target);
    }

    // Working directory
    bwrapArgs.push('--chdir', '/workspace');

    // Unshare everything except network (network sandboxing is out of scope)
    bwrapArgs.push('--unshare-pid');
    bwrapArgs.push('--unshare-uts');
    bwrapArgs.push('--unshare-ipc');

    // Die with parent
    bwrapArgs.push('--die-with-parent');

    // Clear inherited environment completely — do not leak server secrets
    bwrapArgs.push('--clearenv');

    // Build minimal environment: only explicit allowlist
    const env: Record<string, string> = {
      PATH: buildSandboxPath(options.extraPathEntries),
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    };
    if (options.emptyHome) {
      env.HOME = '/home/agent';
      env.XDG_CONFIG_HOME = '/home/agent/.config';
      env.XDG_CACHE_HOME = '/home/agent/.cache';
      env.XDG_STATE_HOME = '/home/agent/.local/state';
      env.XDG_DATA_HOME = '/home/agent/.local/share';
    }
    if (options.outputDir) {
      env.TEEPEE_OUTPUT_DIR = '/teepee-out';
    }
    for (const key of options.forwardEnv) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }

    // Set env vars
    for (const [key, value] of Object.entries(env)) {
      bwrapArgs.push('--setenv', key, value);
    }

    // The actual command
    bwrapArgs.push('--', command, ...args);

    // Spawn with empty env — bwrap --clearenv handles the child env,
    // but we also avoid leaking via the spawn env option
    return nodeSpawn('bwrap', bwrapArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
  }
}

function buildParentDirs(targetPath: string): string[] {
  const normalized = targetPath.replace(/\/+/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const dirs: string[] = [];
  let current = '';
  for (let i = 0; i < parts.length - 1; i++) {
    current += `/${parts[i]}`;
    dirs.push(current);
  }
  return dirs;
}

function buildSandboxPath(extraEntries: string[] | undefined): string {
  const baseEntries = ['/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set([...(extraEntries ?? []), ...baseEntries])].join(':');
}
