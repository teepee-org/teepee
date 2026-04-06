#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import {
  loadConfig,
  openDb,
  createUser,
  listUsers,
  setPermission,
  createInviteToken,
  revokeUserFull,
} from 'teepee-core';
import { startServer } from 'teepee-server';

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
  teepee start [--port <port>]    Start server in the current project root
  teepee stop                     Stop server
  teepee status                   Show status

  teepee invite <email> [--role user|observer]
  teepee revoke <email>
  teepee users

  teepee allow <email> tag <agents|*>
  teepee deny <email> tag <agents|*>

  teepee agents                   List configured agents
  teepee version                  Show CLI version
${usageUpdateLine()}
`);
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
  case 'start': {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;

    ensureDir();

    if (!fs.existsSync(configPath)) {
      // Generate template config
      const template = `teepee:
  name: ${path.basename(process.cwd())}
  language: en

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits"
  codex:
    command: "codex exec"

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
  architect:
    provider: codex
`;
      fs.writeFileSync(configPath, template);
      console.log('Created .teepee/config.yaml with default config.');
      console.log('Edit it, then run: teepee start');
      break;
    }

    const { server } = startServer(configPath, port);

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
    console.log(`Agents: ${Object.keys(config.agents).join(', ')}`);
    console.log(`Users: ${users.length}`);
    console.log('Status: running');
    db.close();
    break;
  }

  case 'invite': {
    const email = args[1];
    if (!email) {
      console.error('Usage: teepee invite <email> [--role user|observer]');
      process.exit(1);
    }
    const roleIdx = args.indexOf('--role');
    const role = roleIdx !== -1 ? args[roleIdx + 1] : 'user';

    ensureDir();
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
    const email = args[1];
    const tagKeyword = args[2]; // 'tag'
    const agents = args[3];
    if (!email || tagKeyword !== 'tag' || !agents) {
      console.error(`Usage: teepee ${command} <email> tag <agents|*>`);
      process.exit(1);
    }
    const allowed = command === 'allow';
    ensureDir();
    const db = openDb(dbPath);
    const agentList = agents === '*' ? ['*'] : agents.split(',');
    for (const agent of agentList) {
      setPermission(db, email, null, agent.trim(), allowed);
      console.log(`${command}: ${email} tag ${agent.trim()}`);
    }
    db.close();
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
