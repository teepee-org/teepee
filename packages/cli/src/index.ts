#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
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

function ensureDir() {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

function usage() {
  console.log(`Teepee — AI agent coordination layer

Package:
  npx teepee-cli <command>
  teepee <command>               Once installed globally

Usage:
  teepee start [--port <port>]    Start server
  teepee stop                     Stop server
  teepee status                   Show status

  teepee invite <email> [--role user|observer]
  teepee revoke <email>
  teepee users

  teepee allow <email> tag <agents|*>
  teepee deny <email> tag <agents|*>

  teepee agents                   List configured agents
  teepee update                   Check for updates
`);
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

  case 'update': {
    console.log('Check for updates: npm install -g teepee-cli@latest');
    break;
  }

  default:
    usage();
    break;
}
