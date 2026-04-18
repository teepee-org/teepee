import * as fs from 'fs';
import * as path from 'path';

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaping = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping || inSingleQuote || inDoubleQuote) {
    throw new Error(`Invalid command: ${command}`);
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

export function isCodexExecCommand(parts: string[]): boolean {
  return parts[0] === 'codex' && parts[1] === 'exec';
}

export function prepareCommandParts(command: string): string[] {
  const parts = splitCommand(command);
  if (isCodexExecCommand(parts) && !parts.includes('--json')) {
    return [...parts, '--json'];
  }
  return parts;
}

const SANDBOX_VISIBLE_EXEC_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/sbin'];

export interface SandboxCommandCheckResult {
  ok: boolean;
  executable: string;
  resolvedPath?: string;
  error?: string;
}

export interface SandboxCommandMountPlan {
  executable: string;
  resolvedPath: string;
  readOnlyPaths: string[];
  pathEntries: string[];
}

export interface SandboxAuthMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export function checkSandboxCommandAvailability(command: string, envPath = '/usr/local/bin:/usr/bin:/bin'): SandboxCommandCheckResult {
  const parts = splitCommand(command);
  const executable = parts[0];

  if (!executable) {
    return { ok: false, executable: '', error: 'empty provider command' };
  }

  if (executable.includes('/')) {
    if (!isSandboxVisibleExecutablePath(executable)) {
      return {
        ok: false,
        executable,
        resolvedPath: executable,
        error: `provider executable '${executable}' is outside the Linux sandbox-visible directories (${SANDBOX_VISIBLE_EXEC_DIRS.join(', ')})`,
      };
    }
    return { ok: true, executable, resolvedPath: executable };
  }

  const sandboxPathDirs = envPath.split(':').filter(Boolean);
  for (const dir of sandboxPathDirs) {
    const fullPath = dir.endsWith('/') ? `${dir}${executable}` : `${dir}/${executable}`;
    if (isSandboxVisibleExecutablePath(fullPath)) {
      return { ok: true, executable, resolvedPath: fullPath };
    }
  }

  const hostResolvedPath = findExecutableOnHostPath(executable);
  if (hostResolvedPath) {
    return {
      ok: false,
      executable,
      resolvedPath: hostResolvedPath,
      error: `provider executable '${executable}' resolves to '${hostResolvedPath}' on the host, but that path is not visible inside the Linux bubblewrap sandbox`,
    };
  }

  return {
    ok: false,
    executable,
    error: `provider executable '${executable}' was not found in the sandbox PATH (${envPath})`,
  };
}

export function buildSandboxCommandMountPlan(
  command: string,
  resolveExecutablePath: (executable: string) => string | undefined = findExecutableOnHostPath
): SandboxCommandMountPlan | null {
  const parts = splitCommand(command);
  const executable = parts[0];
  if (!executable || executable.includes('/')) return null;

  const resolvedPath = resolveExecutablePath(executable);
  if (!resolvedPath || isSandboxVisibleExecutablePath(resolvedPath)) {
    return null;
  }

  return {
    executable,
    resolvedPath,
    readOnlyPaths: [inferExecutablePrefixRoot(resolvedPath)],
    pathEntries: [inferExecutablePathEntry(resolvedPath)],
  };
}

export function buildSandboxAuthMountPlan(
  command: string,
  hostHome = process.env.HOME ?? '',
  sandboxHome = '/home/agent',
  existsSync: (filePath: string) => boolean = fs.existsSync
): SandboxAuthMount[] {
  if (!hostHome) return [];

  const parts = splitCommand(command);
  const executable = parts[0];
  if (!executable) return [];
  const execName = path.basename(executable);

  if (execName === 'claude') {
    return existingMounts([
      { source: path.join(hostHome, '.claude'), target: path.join(sandboxHome, '.claude') },
      { source: path.join(hostHome, '.claude.json'), target: path.join(sandboxHome, '.claude.json') },
      { source: path.join(hostHome, '.local/share/claude'), target: path.join(sandboxHome, '.local/share/claude') },
      { source: path.join(hostHome, '.local/state/claude'), target: path.join(sandboxHome, '.local/state/claude') },
      { source: path.join(hostHome, '.cache/claude'), target: path.join(sandboxHome, '.cache/claude') },
      { source: path.join(hostHome, '.cache/claude-cli-nodejs'), target: path.join(sandboxHome, '.cache/claude-cli-nodejs') },
    ], existsSync);
  }

  if (execName === 'codex') {
    return existingMounts([
      { source: path.join(hostHome, '.codex'), target: path.join(sandboxHome, '.codex') },
    ], existsSync);
  }

  return [];
}

function isSandboxVisibleExecutablePath(filePath: string): boolean {
  return SANDBOX_VISIBLE_EXEC_DIRS.some((dir) => filePath === dir || filePath.startsWith(`${dir}/`));
}

function inferExecutablePrefixRoot(resolvedPath: string): string {
  const normalized = resolvedPath.replace(/\/+/g, '/');
  const binIdx = normalized.lastIndexOf('/bin/');
  if (binIdx > 0) {
    return normalized.slice(0, binIdx);
  }
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
}

function inferExecutablePathEntry(resolvedPath: string): string {
  const normalized = resolvedPath.replace(/\/+/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
}

function findExecutableOnHostPath(executable: string): string | undefined {
  const hostPath = process.env.PATH?.split(':').filter(Boolean) ?? [];
  for (const dir of hostPath) {
    const fullPath = dir.endsWith('/') ? `${dir}${executable}` : `${dir}/${executable}`;
    if (isFileExecutable(fullPath)) return fullPath;
  }
  return undefined;
}

function isFileExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existingMounts(mounts: SandboxAuthMount[], existsSync: (filePath: string) => boolean): SandboxAuthMount[] {
  return mounts.filter((mount) => existsSync(mount.source));
}
