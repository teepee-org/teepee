#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { spawnSync } from 'child_process';
import {
  loadConfig,
  listAssignableRoleIds,
  migrateConfigFileToV2,
  openDb,
  createUser,
  listUsers,
  createInviteToken,
  revokeUserFull,
} from 'teepee-core';
import { startServer } from 'teepee-server';
import { parseServeArgs } from './cli-utils.js';

const args = process.argv.slice(2);
const command = args[0];

const dbDir = path.resolve(process.cwd(), '.teepee');
const configPath = path.join(dbDir, 'config.yaml');
const dbPath = path.join(dbDir, 'db.sqlite');
const pidFile = path.join(dbDir, 'pid');
const cliCacheDir = path.join(os.homedir(), '.teepee');
const updateCachePath = path.join(cliCacheDir, 'update-check.json');
const cliPackageJsonPath = path.resolve(__dirname, '..', 'package.json');
const cliPackage = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf-8')) as {
  name: string;
  version: string;
};
const cliVersion = cliPackage.version;
const cliPackageName = cliPackage.name;
const updateCacheTtlMs = 12 * 60 * 60 * 1000;

function ensureDir() {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

function ensureCliCacheDir() {
  if (!fs.existsSync(cliCacheDir)) fs.mkdirSync(cliCacheDir, { recursive: true });
}

function usageUpdateLine() {
  return '  teepee update                   Check for updates';
}

function usage() {
  console.log(`Teepee — AI agent coordination layer

Package:
  npx teepee-cli <command>
  teepee <command>               Once installed globally

Usage:
  teepee start [options]          Start server in the current project root
  teepee serve [options]          Alias for start

  Options:
    --port <port>                 Server port (default: 3000)
    --host <addr>                 Bind address (default: 127.0.0.1)

  teepee stop                     Stop server
  teepee status                   Show status

  teepee invite <email> [--role <role>]
  teepee revoke <email>
  teepee users
  teepee config migrate-v2 [--config <path>] [--stdout|--write|--check]

  teepee agents                   List configured agents
  teepee version                  Show CLI version
${usageUpdateLine()}
`);
}

function isCommandAvailable(commandName: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [commandName], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveCommandPath(commandName: string): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [commandName], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  return result.stdout.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function isLinuxSandboxVisiblePath(commandPath: string | null): boolean {
  if (!commandPath) return false;
  return ['/usr/local/bin/', '/usr/bin/', '/bin/', '/sbin/'].some((prefix) => commandPath.startsWith(prefix));
}

interface StarterConfigResult {
  template: string;
  detectedProviders: string[];
  skippedLocalProviders: string[];
}

function buildStarterConfig(projectName: string): StarterConfigResult {
  const claudePath = resolveCommandPath('claude');
  const codexPath = resolveCommandPath('codex');
  const ollamaPath = resolveCommandPath('ollama');
  const hasClaude = process.platform === 'linux' ? isLinuxSandboxVisiblePath(claudePath) : isCommandAvailable('claude');
  const hasCodex = process.platform === 'linux' ? isLinuxSandboxVisiblePath(codexPath) : isCommandAvailable('codex');
  const hasOllama = process.platform === 'linux' ? isLinuxSandboxVisiblePath(ollamaPath) : isCommandAvailable('ollama');
  const detectedProviders: string[] = [];
  const providerLines = ['providers:'];
  const agentLines = ['agents:'];
  const configuredAgents: string[] = [];

  const addAgent = (agentName: string, providerName: string) => {
    configuredAgents.push(agentName);
    agentLines.push(`  ${agentName}:`);
    agentLines.push(`    provider: ${providerName}`);
  };

  if (hasClaude) {
    detectedProviders.push('claude');
    providerLines.push('  claude:');
    providerLines.push('    command: "claude -p --permission-mode acceptEdits"');
  }

  if (hasCodex) {
    detectedProviders.push('codex');
    providerLines.push('  codex:');
    providerLines.push('    command: "codex exec"');
  }

  if (hasOllama) {
    detectedProviders.push('ollama');
    providerLines.push('  ollama:');
    providerLines.push('    command: "ollama run qwen2.5-coder:7b"');
  }

  if (hasClaude && hasCodex) {
    addAgent('coder', 'claude');
    addAgent('reviewer', 'claude');
    addAgent('architect', 'codex');
    addAgent('devops', 'codex');
  } else if (hasClaude) {
    for (const agentName of ['coder', 'reviewer', 'architect', 'devops']) {
      addAgent(agentName, 'claude');
    }
  } else if (hasCodex) {
    for (const agentName of ['coder', 'reviewer', 'architect', 'devops']) {
      addAgent(agentName, 'codex');
    }
  } else if (hasOllama) {
    for (const agentName of ['coder', 'reviewer', 'architect', 'devops']) {
      addAgent(agentName, 'ollama');
    }
  } else {
    providerLines.push('  # claude:');
    providerLines.push('  #   command: "claude -p --permission-mode acceptEdits"');
    providerLines.push('  # codex:');
    providerLines.push('  #   command: "codex exec"');
    providerLines.push('  # ollama:');
    providerLines.push('  #   command: "ollama run qwen2.5-coder:7b"');
    agentLines.push('  # coder:');
    agentLines.push('  #   provider: claude');
    agentLines.push('  # reviewer:');
    agentLines.push('  #   provider: claude');
    agentLines.push('  # architect:');
    agentLines.push('  #   provider: codex');
    agentLines.push('  # devops:');
    agentLines.push('  #   provider: codex');
  }

  const skippedLocalProviders: string[] =
    process.platform === 'linux'
      ? ([
          claudePath && !hasClaude ? `claude at ${claudePath}` : null,
          codexPath && !hasCodex ? `codex at ${codexPath}` : null,
          ollamaPath && !hasOllama ? `ollama at ${ollamaPath}` : null,
        ].filter(Boolean) as string[])
      : [];
  if (skippedLocalProviders.length > 0) {
    providerLines.push('  #');
    providerLines.push('  # Note: these CLIs were found on the host but skipped for sandboxed auto-config because');
    providerLines.push('  # Linux bubblewrap only sees /usr/local/bin, /usr/bin, /bin, and /sbin by default:');
    for (const item of skippedLocalProviders) {
      providerLines.push(`  # - ${item}`);
    }
  }

  const collaboratorCapabilities = [
    'files.workspace.access',
    'topics.create',
    'topics.rename',
    'topics.archive',
    'topics.restore',
    'topics.move',
    'topics.language.set',
    'messages.post',
  ];
  const roleLines = [
    'roles:',
    '  owner:',
    '    superuser: true',
  ];
  if (configuredAgents.length === 0) {
    roleLines.push('    agents: {}');
  } else {
    roleLines.push('    agents:');
    for (const agentName of configuredAgents) {
      roleLines.push(`      ${agentName}: ${agentName === 'devops' ? 'trusted' : 'readwrite'}`);
    }
  }
  roleLines.push('  collaborator:');
  roleLines.push('    capabilities:');
  for (const capability of collaboratorCapabilities) {
    roleLines.push(`      - ${capability}`);
  }
  if (configuredAgents.length === 0) {
    roleLines.push('    agents: {}');
  } else {
    roleLines.push('    agents:');
    for (const agentName of configuredAgents) {
      roleLines.push(`      ${agentName}: readwrite`);
    }
  }
  roleLines.push('  observer:');
  roleLines.push('    capabilities:');
  roleLines.push('      - files.workspace.access');
  roleLines.push('    agents: {}');

  const template = [
    'version: 2',
    'mode: private',
    '',
    'teepee:',
    `  name: ${projectName}`,
    '  language: en',
    '',
    'filesystem:',
    '  roots:',
    '    - id: workspace',
    '      kind: workspace',
    '      path: .',
    '',
    ...providerLines,
    '',
    ...agentLines,
    ...(configuredAgents.length > 0 ? ['', ...roleLines] : []),
    '',
  ].join('\n');

  return { template, detectedProviders, skippedLocalProviders };
}

function printConfigMigrateUsage() {
  console.log('Usage: teepee config migrate-v2 [--config <path>] [--stdout|--write|--check]');
}

function handleConfigCommand(commandArgs: string[]) {
  const subcommand = commandArgs[1];
  if (subcommand !== 'migrate-v2') {
    printConfigMigrateUsage();
    process.exit(1);
  }

  const configIdx = commandArgs.indexOf('--config');
  const targetConfigPath = configIdx !== -1 ? commandArgs[configIdx + 1] : configPath;
  if (!targetConfigPath) {
    console.error('Missing value for --config');
    process.exit(1);
  }

  const write = commandArgs.includes('--write');
  const check = commandArgs.includes('--check');
  const stdout = commandArgs.includes('--stdout') || (!write && !check);
  const modeCount = Number(write) + Number(check) + Number(commandArgs.includes('--stdout'));
  if (modeCount > 1) {
    console.error('Use only one of --stdout, --write, or --check');
    process.exit(1);
  }

  try {
    const result = migrateConfigFileToV2(path.resolve(targetConfigPath), { write });
    if (check) {
      process.exit(result.migrated ? 2 : 0);
    }
    if (stdout) {
      process.stdout.write(result.output);
      if (!result.output.endsWith('\n')) process.stdout.write('\n');
      return;
    }
    if (result.migrated) {
      console.log(
        result.sourceVersion === 1
          ? `Config migrated to v2: ${path.resolve(targetConfigPath)}`
          : `Config normalized to latest v2 schema: ${path.resolve(targetConfigPath)}`
      );
      if (result.backupPath) {
        console.log(`Backup: ${result.backupPath}`);
      }
    } else {
      console.log(`Config already uses version 2: ${path.resolve(targetConfigPath)}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const aParts = parse(a);
  const bParts = parse(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readCachedLatestVersion(): string | null {
  try {
    if (!fs.existsSync(updateCachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(updateCachePath, 'utf-8')) as {
      latest?: string;
      checked_at?: number;
      package_name?: string;
    };
    if (raw.package_name !== cliPackageName) return null;
    if (!raw.latest || typeof raw.checked_at !== 'number') return null;
    if (Date.now() - raw.checked_at > updateCacheTtlMs) return null;
    return raw.latest;
  } catch {
    return null;
  }
}

function writeCachedLatestVersion(latest: string) {
  try {
    ensureCliCacheDir();
    fs.writeFileSync(
      updateCachePath,
      JSON.stringify(
        {
          package_name: cliPackageName,
          latest,
          checked_at: Date.now(),
        },
        null,
        2
      )
    );
  } catch {
    // Best-effort cache only.
  }
}

function fetchLatestVersionFromRegistry(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://registry.npmjs.org/${cliPackageName}/latest`,
      {
        timeout: 5000,
        headers: {
          Accept: 'application/json',
          'User-Agent': `${cliPackageName}/${cliVersion}`,
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`Registry request failed with status ${res.statusCode || 'unknown'}`));
          res.resume();
          return;
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { version?: string };
            if (!parsed.version) {
              reject(new Error('Registry response did not include a version'));
              return;
            }
            resolve(parsed.version);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Registry request timed out'));
    });
    req.on('error', reject);
  });
}

async function getLatestVersion(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = readCachedLatestVersion();
    if (cached) return cached;
  }

  const latest = await fetchLatestVersionFromRegistry();
  writeCachedLatestVersion(latest);
  return latest;
}

async function showUpdateStatus(forceRefresh = false) {
  console.log(`Teepee CLI ${cliVersion}`);

  try {
    const latest = await getLatestVersion(forceRefresh);
    if (compareVersions(latest, cliVersion) > 0) {
      console.log(`Latest version: ${latest}`);
      console.log('Update available.');
      console.log('');
      console.log('Use one of these:');
      console.log(`  npx ${cliPackageName}@latest start`);
      console.log(`  npm install -g ${cliPackageName}@latest`);
    } else {
      console.log(`Latest version: ${latest}`);
      console.log('You are up to date.');
    }
  } catch (error: any) {
    console.log('Could not check the npm registry right now.');
    console.log(`Current version: ${cliVersion}`);
    console.log(`Manual update: npm install -g ${cliPackageName}@latest`);
    if (error?.message) {
      console.log(`Reason: ${error.message}`);
    }
  }
}

switch (command) {
  case 'config': {
    handleConfigCommand(args);
    break;
  }

  case 'start':
  case 'serve': {
    let port: number;
    let host: string;
    try {
      ({ port, host } = parseServeArgs(args));
    } catch (error: any) {
      console.error(error.message);
      process.exit(1);
    }

    ensureDir();

    if (!fs.existsSync(configPath)) {
      const { template, detectedProviders, skippedLocalProviders } = buildStarterConfig(path.basename(process.cwd()));
      fs.writeFileSync(configPath, template);
      console.log('Created .teepee/config.yaml.');
      if (detectedProviders.length > 0) {
        console.log(`Detected agent CLIs: ${detectedProviders.join(', ')}`);
      } else if (skippedLocalProviders.length > 0) {
        console.log('');
        console.log('Detected these agent CLIs on the host, but they are installed outside');
        console.log('the sandbox-visible directories (/usr/local/bin, /usr/bin, /bin, /sbin)');
        console.log('so they were commented out in the generated config:');
        for (const item of skippedLocalProviders) {
          console.log(`  - ${item}`);
        }
        console.log('');
        console.log('Open .teepee/config.yaml and uncomment the ones you want to use.');
        console.log('Teepee will mount their paths into the sandbox automatically.');
      } else {
        console.log('No supported agent CLI was detected in PATH.');
        console.log('Install Claude Code, Codex, or Ollama, or edit the config manually.');
      }
      if (detectedProviders.includes('ollama')) {
        console.log('Note: the default Ollama command uses qwen2.5-coder:7b. Change the model name if needed.');
      }
      console.log('Edit it if needed, then run: npx teepee-cli start');
      console.log('Set mode: shared in .teepee/config.yaml before inviting teammates.');
      break;
    }

    let server: ReturnType<typeof startServer>['server'];
    try {
      ({ server } = startServer(configPath, port, { host }));
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('at least one provider is required')) {
        console.error('');
        console.error('Teepee cannot start: no providers are configured.');
        console.error('Edit .teepee/config.yaml and uncomment at least one provider under `providers:`.');
        console.error('');
        process.exit(1);
      }
      if (msg.includes('can only bind to a loopback host')) {
        console.error('');
        console.error(msg);
        console.error('');
        process.exit(1);
      }
      console.error(msg);
      process.exit(1);
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('');
        console.error(`Port ${port} is already in use.`);
        console.error(`  Try: teepee start --port ${port + 1}`);
        console.error(`  Or stop the process using port ${port}.`);
        console.error('');
        process.exit(1);
      }
      if (err.code === 'EACCES') {
        console.error('');
        console.error(`Permission denied binding port ${port} on ${host}.`);
        console.error(`  Ports below 1024 usually require elevated privileges.`);
        console.error('');
        process.exit(1);
      }
      console.error(`Server error: ${err.message}`);
      process.exit(1);
    });

    // Save PID
    fs.writeFileSync(pidFile, String(process.pid));

    // Open browser
    const openUrl = `http://localhost:${port}`;
    try {
      const { exec } = require('child_process');
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      exec(`${cmd} ${openUrl}`);
    } catch {
      // No browser available
    }

    // Cleanup on exit
    process.on('SIGTERM', () => {
      server.close();
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      process.exit(0);
    });
    process.on('SIGINT', () => {
      server.close();
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      process.exit(0);
    });
    break;
  }

  case 'stop': {
    if (!fs.existsSync(pidFile)) {
      console.log('Teepee is not running.');
      break;
    }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(pidFile);
      console.log('Teepee stopped.');
    } catch {
      fs.unlinkSync(pidFile);
      console.log('Process not found, cleaned up PID file.');
    }
    break;
  }

  case 'status': {
    if (!fs.existsSync(pidFile)) {
      console.log('Teepee is not running.');
      break;
    }
    const config = loadConfig(configPath);
    const db = openDb(dbPath);
    const users = listUsers(db);
    console.log(`Teepee: ${config.teepee.name}`);
    console.log(`Mode: ${config.mode}`);
    console.log(`Agents: ${Object.keys(config.agents).join(', ')}`);
    console.log(`Users: ${users.length}`);
    console.log('Status: running');
    db.close();
    break;
  }

  case 'invite': {
    const email = args[1];
    if (!email) {
      console.error('Usage: teepee invite <email> [--role <role>]');
      process.exit(1);
    }
    const roleIdx = args.indexOf('--role');
    const rawRole = roleIdx !== -1 ? args[roleIdx + 1] : 'collaborator';
    const role = rawRole === 'user' ? 'collaborator' : rawRole;

    ensureDir();
    const config = loadConfig(configPath);
    const assignableRoles = listAssignableRoleIds(config);
    if (!assignableRoles.includes(role)) {
      console.error(`Invalid invite role: ${rawRole}. Use one of: ${assignableRoles.join(', ')}`);
      process.exit(1);
    }
    if (config.mode !== 'shared') {
      console.error('Invites are only available when .teepee/config.yaml has mode: shared');
      process.exit(1);
    }
    const db = openDb(dbPath);
    try {
      createUser(db, email, role);
      const token = createInviteToken(db, email);
      console.log(`Invited ${email} as ${role}`);
      console.log(`Invite token: ${token}`);
      console.log(`Magic link:   http://<your-host>:<port>/invite/${token}`);
      console.log(`(Replace <your-host>:<port> with your Teepee server address)`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
    db.close();
    break;
  }

  case 'revoke': {
    const email = args[1];
    if (!email) {
      console.error('Usage: teepee revoke <email>');
      process.exit(1);
    }
    const db = openDb(dbPath);
    if (revokeUserFull(db, email)) {
      console.log(`Revoked ${email}`);
    } else {
      console.log(`User not found: ${email}`);
    }
    db.close();
    break;
  }

  case 'users': {
    ensureDir();
    const db = openDb(dbPath);
    const users = listUsers(db);
    if (users.length === 0) {
      console.log('No users.');
    } else {
      for (const u of users) {
        console.log(
          `${u.email}  handle=${u.handle || '(pending)'}  role=${u.role}  status=${u.status}`
        );
      }
    }
    db.close();
    break;
  }

  case 'allow':
  case 'deny': {
    console.error(`teepee ${command} is deprecated. Agent access is now configured in .teepee/config.yaml under roles.`);
    process.exit(1);
    break;
  }

  case 'agents': {
    const config = loadConfig(configPath);
    for (const [name, agent] of Object.entries(config.agents)) {
      const provider = config.providers[agent.provider];
      console.log(
        `${name}  provider=${agent.provider}  command="${provider.command}"${agent.prompt ? `  prompt=${agent.prompt}` : ''}`
      );
    }
    break;
  }

  case 'version': {
    console.log(cliVersion);
    break;
  }

  case 'update': {
    void showUpdateStatus(true);
    break;
  }

  default:
    usage();
    break;
}
