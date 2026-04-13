import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hasCapability,
  listAssignableRoleIds,
  loadConfig,
  migrateConfigFileToV2,
  resolveRoleAgentProfile,
} from './config.js';

function tmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-config-v2-'));
  const teepeeDir = path.join(dir, '.teepee');
  fs.mkdirSync(teepeeDir, { recursive: true });
  const file = path.join(teepeeDir, 'config.yaml');
  fs.writeFileSync(file, content);
  return file;
}

describe('config v2 roles', () => {
  it('loads arbitrary roles with capabilities and owner superuser', () => {
    const file = tmpConfig(`
version: 2
mode: shared
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  coder:
    provider: p
  reviewer:
    provider: p
roles:
  owner:
    superuser: true
    agents:
      coder: trusted
      reviewer: trusted
  admin:
    capabilities:
      - admin.view
      - users.invite
      - messages.post
    agents:
      coder: readwrite
      reviewer: readonly
  qa:
    capabilities:
      - messages.post
      - topics.rename
    agents:
      reviewer: trusted
`);
    const config = loadConfig(file);
    expect(listAssignableRoleIds(config)).toEqual(['admin', 'qa']);
    expect(hasCapability(config, 'owner', 'artifacts.promote')).toBe(true);
    expect(hasCapability(config, 'admin', 'admin.view')).toBe(true);
    expect(hasCapability(config, 'qa', 'topics.rename')).toBe(true);
    expect(hasCapability(config, 'qa', 'admin.view')).toBe(false);
    expect(resolveRoleAgentProfile(config, 'qa', 'reviewer')).toBe('trusted');
    expect(resolveRoleAgentProfile(config, 'qa', 'coder')).toBeNull();
  });

  it('fails closed for roles missing from config', () => {
    const file = tmpConfig(`
version: 2
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  coder:
    provider: p
roles:
  owner:
    superuser: true
    agents:
      coder: trusted
`);
    const config = loadConfig(file);
    expect(hasCapability(config, 'ghost', 'messages.post')).toBe(false);
    expect(resolveRoleAgentProfile(config, 'ghost', 'coder')).toBeNull();
  });

  it('defaults missing role agents to an empty map', () => {
    const file = tmpConfig(`
version: 2
mode: shared
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  coder:
    provider: p
roles:
  owner:
    superuser: true
  admin:
    capabilities:
      - admin.view
      - messages.post
`);
    const config = loadConfig(file);
    expect(hasCapability(config, 'admin', 'admin.view')).toBe(true);
    expect(resolveRoleAgentProfile(config, 'admin', 'coder')).toBeNull();
    expect(resolveRoleAgentProfile(config, 'owner', 'coder')).toBeNull();
  });

  it('migrates legacy v1 configs to canonical v2 output', () => {
    const file = tmpConfig(`
version: 1
mode: shared
teepee:
  name: test
providers:
  p:
    command: "echo"
agents:
  coder:
    provider: p
    profile: trusted
  reviewer:
    provider: p
`);

    const result = migrateConfigFileToV2(file);
    expect(result.migrated).toBe(true);
    expect(result.output).toContain('version: 2');
    expect(result.output).toContain('superuser: true');
    expect(result.output).toContain('capabilities:');
    expect(result.output).not.toContain('filesystem:');
    expect(result.output).not.toContain('profile: trusted');

    fs.writeFileSync(file, result.output, 'utf-8');
    const config = loadConfig(file);
    expect(config.version).toBe(2);
    expect(hasCapability(config, 'collaborator', 'messages.post')).toBe(true);
    expect(hasCapability(config, 'observer', 'files.workspace.access')).toBe(true);
    expect(resolveRoleAgentProfile(config, 'owner', 'coder')).toBe('trusted');
    expect(resolveRoleAgentProfile(config, 'collaborator', 'reviewer')).toBe('readwrite');
  });

  it('normalizes existing v2 configs stripping filesystem and adding workspace access defaults', () => {
    const file = tmpConfig(`
version: 2
mode: shared
teepee:
  name: test
filesystem:
  roots:
    - id: workspace
      kind: workspace
      path: .
providers:
  p:
    command: "echo"
agents:
  coder:
    provider: p
roles:
  owner:
    superuser: true
  collaborator:
    capabilities:
      - messages.post
    agents:
      coder: readwrite
  observer:
    capabilities: []
    agents: {}
`);

    const result = migrateConfigFileToV2(file);
    expect(result.migrated).toBe(true);
    expect(result.output).not.toContain('filesystem:');
    expect(result.output).toContain('files.workspace.access');
  });
});
