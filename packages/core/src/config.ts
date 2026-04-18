import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ProviderSandboxConfig {
  /** Container image that includes the provider CLI. */
  image: string;
  /** Command to run inside the container (defaults to provider.command). */
  command?: string;
}

export interface ProviderConfig {
  command: string;
  /**
   * Idle timeout in seconds. The runner kills the provider process if no
   * stdout/stderr chunk has been received for this many seconds. Defaults to
   * 180 when neither agent nor provider sets a value.
   */
  timeout_seconds?: number;
  /**
   * Grace window in seconds between SIGTERM and SIGKILL when the idle timeout
   * fires. Defaults to 5.
   */
  kill_grace_seconds?: number;
  /** Sandbox runtime config for container-based execution. */
  sandbox?: ProviderSandboxConfig;
}

export type UserRole = string;

export type TeepeeMode = 'private' | 'shared';

export type AgentAccessProfile = 'readonly' | 'draft' | 'readwrite' | 'trusted';

/** @deprecated Use AgentAccessProfile. */
export type AgentProfile = AgentAccessProfile;

export type ChainPolicy = 'none' | 'propose_only' | 'delegate_with_origin_policy';

export interface AgentConfig {
  provider: string;
  prompt?: string;
  timeout_seconds?: number;
  chain_policy?: ChainPolicy;
}

export type ExecutionMode = 'host' | 'sandbox' | 'db_only' | 'disabled';

export interface SecurityConfig {
  sandbox: {
    runner: 'bubblewrap' | 'container';
    empty_home: boolean;
    private_tmp: boolean;
    forward_env: string[];
    /** Container image for macOS/container sandbox backend. */
    container_image?: string;
  };
}

export interface LimitsConfig {
  max_agents_per_message: number;
  max_jobs_per_user_per_minute: number;
  max_chain_depth: number;
  max_total_jobs_per_chain: number;
}

export const CAPABILITIES = [
  'files.workspace.access',
  'files.host.access',
  'admin.view',
  'users.list',
  'users.invite',
  'users.revoke',
  'users.reenable',
  'users.delete',
  'users.role.set',
  'users.owner.promote',
  'users.owner.demote',
  'topics.create',
  'topics.rename',
  'topics.archive',
  'topics.restore',
  'topics.move',
  'topics.language.set',
  'topics.alias.set',
  'messages.post',
  'artifacts.promote',
  'input_requests.cancel.any',
] as const;

export type Capability = typeof CAPABILITIES[number];

export type FilesystemRootKind = 'workspace' | 'host';

export interface FilesystemRootConfig {
  id: string;
  kind: FilesystemRootKind;
  path: string;
  resolvedPath: string;
}

export interface FilesystemConfig {
  roots: FilesystemRootConfig[];
}

export interface BaseRoleConfig {
  agents: Record<string, AgentAccessProfile>;
}

export interface OwnerRoleConfig extends BaseRoleConfig {
  superuser: true;
  capabilities?: never;
}

export interface NonOwnerRoleConfig extends BaseRoleConfig {
  capabilities: Capability[];
  superuser?: false;
}

export type RoleConfig = OwnerRoleConfig | NonOwnerRoleConfig;
export type RoleConfigMap = Record<string, RoleConfig>;

export interface TeepeeConfig {
  version: 1 | 2;
  mode: TeepeeMode;
  teepee: {
    name: string;
    language: string;
    demo: {
      enabled: boolean;
      topic_name: string;
      hotkey: string;
      delay_ms: number;
    };
  };
  server: {
    trust_proxy: boolean;
    cors_allowed_origins: string[];
    auth_rate_limit_window_seconds: number;
    auth_rate_limit_max_requests: number;
  };
  providers: Record<string, ProviderConfig>;
  agents: Record<string, AgentConfig>;
  roles: RoleConfigMap;
  filesystem: FilesystemConfig;
  limits: LimitsConfig;
  security: SecurityConfig;
}

export interface ConfigMigrationOptions {
  write?: boolean;
  backupPath?: string;
}

export interface ConfigMigrationResult {
  migrated: boolean;
  output: string;
  sourceVersion: 1 | 2;
  backupPath?: string;
}

const DEFAULT_SERVER = {
  trust_proxy: false,
  cors_allowed_origins: [] as string[],
  auth_rate_limit_window_seconds: 60,
  auth_rate_limit_max_requests: 20,
};

const DEFAULT_DEMO = {
  enabled: false,
  topic_name: 'hn-live-demo',
  hotkey: 'F1',
  delay_ms: 1200,
};

const DEFAULT_LIMITS: LimitsConfig = {
  max_agents_per_message: 5,
  max_jobs_per_user_per_minute: 10,
  max_chain_depth: 2,
  max_total_jobs_per_chain: 10,
};

function buildFilesystemConfig(projectRoot: string): FilesystemConfig {
  return {
    roots: [
      { id: 'workspace', kind: 'workspace', path: '.', resolvedPath: path.resolve(projectRoot, '.') },
      { id: 'host', kind: 'host', path: '/', resolvedPath: '/' },
    ],
  };
}

const DEFAULT_SECURITY: SecurityConfig = {
  sandbox: {
    runner: 'bubblewrap',
    empty_home: true,
    private_tmp: true,
    forward_env: [],
  },
};

const VALID_LEGACY_CAPABILITIES = new Set<string>(['host_allowed', 'sandbox_only', 'disabled']);
const VALID_LEGACY_AGENT_PROFILES = new Set<string>(['restricted', 'normal', 'trusted']);
const VALID_ACCESS_PROFILES = new Set<string>(['readonly', 'draft', 'readwrite', 'trusted']);
const VALID_CHAIN_POLICIES = new Set<string>(['none', 'propose_only', 'delegate_with_origin_policy']);
const VALID_SANDBOX_RUNNERS = new Set<string>(['bubblewrap', 'container']);
const VALID_CAPABILITIES = new Set<Capability>(CAPABILITIES);
const LEGACY_ROLE_IDS = new Set(['owner', 'collaborator', 'observer']);
const RESERVED_ROLE_IDS = new Set(['user', 'all', 'ALL', '*']);
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const LEGACY_COLLABORATOR_CAPABILITIES: Capability[] = [
  'files.workspace.access',
  'topics.create',
  'topics.rename',
  'topics.archive',
  'topics.restore',
  'topics.move',
  'topics.language.set',
  'messages.post',
];

const LEGACY_OBSERVER_CAPABILITIES: Capability[] = ['files.workspace.access'];

export function loadConfig(configPath: string): TeepeeConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  validateTopLevelSecurityKeys(parsed);
  const version = parseConfigVersion(parsed.version);
  const mode = parseConfigMode(parsed.mode);
  const projectRoot = path.dirname(path.dirname(path.resolve(configPath)));

  if (!parsed.teepee?.name) {
    throw new Error('Config: teepee.name is required');
  }

  const config: TeepeeConfig = {
    version,
    mode,
    teepee: {
      name: parsed.teepee.name,
      language: parsed.teepee.language || 'en',
      demo: {
        enabled: parsed.teepee.demo?.enabled ?? DEFAULT_DEMO.enabled,
        topic_name: parsed.teepee.demo?.topic_name ?? DEFAULT_DEMO.topic_name,
        hotkey: parsed.teepee.demo?.hotkey ?? DEFAULT_DEMO.hotkey,
        delay_ms: parsed.teepee.demo?.delay_ms ?? DEFAULT_DEMO.delay_ms,
      },
    },
    server: {
      trust_proxy: parsed.server?.trust_proxy ?? DEFAULT_SERVER.trust_proxy,
      cors_allowed_origins: normalizeOrigins(
        parsed.server?.cors_allowed_origins ?? DEFAULT_SERVER.cors_allowed_origins
      ),
      auth_rate_limit_window_seconds:
        parsed.server?.auth_rate_limit_window_seconds ??
        DEFAULT_SERVER.auth_rate_limit_window_seconds,
      auth_rate_limit_max_requests:
        parsed.server?.auth_rate_limit_max_requests ??
        DEFAULT_SERVER.auth_rate_limit_max_requests,
    },
    providers: {},
    agents: {},
    roles: {},
    filesystem: buildFilesystemConfig(projectRoot),
    limits: { ...DEFAULT_LIMITS, ...parsed.limits },
    security: buildSecurityConfig(parsed.security),
  };

  if (!parsed.providers || Object.keys(parsed.providers).length === 0) {
    throw new Error('Config: at least one provider is required');
  }

  for (const [name, prov] of Object.entries(parsed.providers)) {
    const p = prov as any;
    if (!p.command) {
      throw new Error(`Config: provider '${name}' missing 'command'`);
    }
    const providerEntry: ProviderConfig = {
      command: p.command,
      timeout_seconds: p.timeout_seconds,
      kill_grace_seconds: p.kill_grace_seconds,
    };
    if (p.sandbox) {
      if (!p.sandbox.image || typeof p.sandbox.image !== 'string') {
        throw new Error(`Config: provider '${name}' sandbox requires a valid 'image'`);
      }
      if (p.sandbox.command !== undefined && typeof p.sandbox.command !== 'string') {
        throw new Error(`Config: provider '${name}' sandbox.command must be a string`);
      }
      providerEntry.sandbox = {
        image: p.sandbox.image,
        command: p.sandbox.command,
      };
    }
    config.providers[name] = providerEntry;
  }

  if (!parsed.agents || Object.keys(parsed.agents).length === 0) {
    throw new Error('Config: at least one agent is required');
  }

  const agentNames = new Set<string>();
  const usingRoleMatrix = parsed.roles !== undefined;
  for (const [name, ag] of Object.entries(parsed.agents)) {
    const a = ag as any;
    if (!a.provider) {
      throw new Error(`Config: agent '${name}' missing 'provider'`);
    }
    if (!config.providers[a.provider]) {
      throw new Error(
        `Config: agent '${name}' references unknown provider '${a.provider}'`
      );
    }
    if (agentNames.has(name)) {
      throw new Error(`Config: duplicate agent name '${name}'`);
    }
    agentNames.add(name);

    if (usingRoleMatrix) {
      if (a.profile !== undefined) {
        throw new Error(`Config: agent '${name}' uses legacy 'profile'; move access profiles to roles.<role>.agents.${name}`);
      }
      if (a.capability !== undefined) {
        throw new Error(`Config: agent '${name}' uses legacy 'capability'; omit the agent from roles.<role>.agents to deny access`);
      }
    } else {
      validateLegacyAgentSecurity(name, a);
    }

    let chainPolicy: ChainPolicy;
    if (a.chain_policy !== undefined) {
      if (!VALID_CHAIN_POLICIES.has(a.chain_policy)) {
        throw new Error(`Config: agent '${name}' has invalid chain_policy '${a.chain_policy}'`);
      }
      chainPolicy = a.chain_policy as ChainPolicy;
    } else {
      chainPolicy = 'delegate_with_origin_policy';
    }

    config.agents[name] = {
      provider: a.provider,
      prompt: a.prompt,
      timeout_seconds: a.timeout_seconds,
      chain_policy: chainPolicy,
    };
  }

  config.roles = usingRoleMatrix
    ? buildRolesConfig(parsed.roles, agentNames, version)
    : buildLegacyRolesFromAgents(parsed.agents, agentNames);

  return config;
}

export function migrateConfigFileToV2(
  configPath: string,
  options: ConfigMigrationOptions = {}
): ConfigMigrationResult {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const rawText = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(rawText);
  const version = parseConfigVersion(parsed?.version);
  const config = loadConfig(configPath);
  const needsMigration = version !== 2 || needsV2ConfigNormalization(parsed);
  if (!needsMigration) {
    return { migrated: false, output: rawText, sourceVersion: version };
  }

  const migratedDocument = buildMigratedConfigDocument(parsed, config);
  const output = stringifyYaml(migratedDocument);
  validateMigratedConfigOutput(configPath, output);

  if (!options.write) {
    return { migrated: true, output, sourceVersion: version };
  }

  const backupPath = options.backupPath ?? nextAvailableBackupPath(configPath, version);
  fs.copyFileSync(configPath, backupPath);

  try {
    writeFileAtomically(configPath, output);
    const reloaded = loadConfig(configPath);
    if (reloaded.version !== 2) {
      throw new Error('Config migration did not produce version 2');
    }
  } catch (error) {
    writeFileAtomically(configPath, fs.readFileSync(backupPath, 'utf-8'));
    throw error;
  }

  return { migrated: true, output, sourceVersion: version, backupPath };
}

export function resolvePrompt(
  agentName: string,
  agentConfig: AgentConfig,
  basePath: string
): string {
  if (agentConfig.prompt) {
    const promptPath = path.resolve(basePath, agentConfig.prompt);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    throw new Error(
      `Prompt file not found for agent '${agentName}': ${promptPath}`
    );
  }

  const namedDefault = path.resolve(
    basePath,
    'default-prompts',
    `${agentName}.md`
  );
  if (fs.existsSync(namedDefault)) {
    return fs.readFileSync(namedDefault, 'utf-8');
  }

  const fallback = path.resolve(basePath, 'default-prompts', 'default.md');
  if (fs.existsSync(fallback)) {
    return fs.readFileSync(fallback, 'utf-8');
  }

  return `You are ${agentName}, an AI assistant.`;
}

/** Default idle timeout in seconds when neither agent nor provider overrides it. */
export const DEFAULT_TIMEOUT_SECONDS = 180;
/** Default SIGTERM→SIGKILL grace window in seconds when a provider is killed on idle timeout. */
export const DEFAULT_KILL_GRACE_SECONDS = 5;

/**
 * Resolve the idle timeout (in milliseconds) for an agent, with the
 * agent → provider → default fallback chain.
 */
export function resolveTimeout(
  agentName: string,
  config: TeepeeConfig
): number {
  const agent = config.agents[agentName];
  if (agent?.timeout_seconds) return agent.timeout_seconds * 1000;
  const provider = config.providers[agent?.provider];
  if (provider?.timeout_seconds) return provider.timeout_seconds * 1000;
  return DEFAULT_TIMEOUT_SECONDS * 1000;
}

/**
 * Resolve the SIGTERM→SIGKILL grace window (in milliseconds) for an agent.
 * Only the provider-level setting is meaningful; the agent can override for
 * parity with timeout_seconds.
 */
export function resolveKillGrace(
  agentName: string,
  config: TeepeeConfig
): number {
  const agent = config.agents[agentName];
  const provider = config.providers[agent?.provider];
  if (provider?.kill_grace_seconds !== undefined) {
    return provider.kill_grace_seconds * 1000;
  }
  return DEFAULT_KILL_GRACE_SECONDS * 1000;
}

export function isOwnerRole(role: string): boolean {
  return role === 'owner';
}

export function normalizeConfiguredRole(role: string): string {
  return role === 'user' ? 'collaborator' : role;
}

export function getRoleConfig(
  config: TeepeeConfig,
  role: string
): RoleConfig | null {
  const normalized = normalizeConfiguredRole(role);
  return config.roles[normalized] ?? null;
}

export function hasRole(
  config: TeepeeConfig,
  role: string
): boolean {
  return getRoleConfig(config, role) !== null;
}

export function listRoleIds(config: TeepeeConfig): string[] {
  return Object.keys(config.roles);
}

export function listAssignableRoleIds(config: TeepeeConfig): string[] {
  return listRoleIds(config).filter((role) => !isOwnerRole(role));
}

export function getFilesystemRoot(
  config: TeepeeConfig,
  rootId: string
): FilesystemRootConfig | null {
  return config.filesystem.roots.find((root) => root.id === rootId) ?? null;
}

export function listFilesystemRoots(config: TeepeeConfig): FilesystemRootConfig[] {
  return config.filesystem.roots.map((root) => ({ ...root }));
}

export function requiredCapabilityForFilesystemRoot(
  root: Pick<FilesystemRootConfig, 'kind'>
): Capability {
  return root.kind === 'workspace' ? 'files.workspace.access' : 'files.host.access';
}

export function listAccessibleFilesystemRoots(
  config: TeepeeConfig,
  role: string
): FilesystemRootConfig[] {
  return config.filesystem.roots
    .filter((root) => hasCapability(config, role, requiredCapabilityForFilesystemRoot(root)))
    .map((root) => ({ ...root }));
}

export function listRoleCapabilities(
  config: TeepeeConfig,
  role: string
): Capability[] {
  const roleConfig = getRoleConfig(config, role);
  if (!roleConfig) return [];
  if ('superuser' in roleConfig && roleConfig.superuser) {
    return [...CAPABILITIES];
  }
  return [...roleConfig.capabilities];
}

export function hasCapability(
  config: TeepeeConfig,
  role: string,
  capability: Capability
): boolean {
  const roleConfig = getRoleConfig(config, role);
  if (!roleConfig) return false;
  if ('superuser' in roleConfig && roleConfig.superuser) {
    return true;
  }
  return roleConfig.capabilities.includes(capability);
}

export function resolveRoleAgentProfile(
  config: TeepeeConfig,
  role: string,
  agentName: string
): AgentAccessProfile | null {
  if (!config.agents[agentName]) return null;
  const roleConfig = getRoleConfig(config, role);
  if (!roleConfig) return null;
  return roleConfig.agents[agentName] ?? null;
}

function validateTopLevelSecurityKeys(parsed: any): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Config: expected a YAML object');
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'default_role') {
      throw new Error("Config: default_role is not supported; assign roles explicitly via invites/users");
    }
    if (key === 'profiles') {
      throw new Error(`Config: custom '${key}' are not supported; profiles are built-in: readonly, draft, readwrite, trusted`);
    }
  }
}

function parseConfigVersion(value: unknown): 1 | 2 {
  if (value === undefined || value === null) return 1;
  if (value !== 1 && value !== 2) {
    throw new Error(`Config: version must be 1 or 2 (got '${value}')`);
  }
  return value;
}

function parseConfigMode(value: unknown): TeepeeMode {
  if (value === undefined || value === null) return 'private';
  if (value === 'private' || value === 'shared') return value;
  throw new Error(`Config: mode must be 'private' or 'shared' (got '${value}')`);
}

const VALID_SECURITY_KEYS = new Set(['sandbox']);
const VALID_SANDBOX_KEYS = new Set(['runner', 'empty_home', 'private_tmp', 'forward_env', 'container_image']);

function validateLegacyAgentSecurity(name: string, agent: any): void {
  if (agent.capability !== undefined && !VALID_LEGACY_CAPABILITIES.has(agent.capability)) {
    throw new Error(
      `Config: agent '${name}' has invalid capability '${agent.capability}'`
    );
  }
  if (agent.profile !== undefined && !VALID_LEGACY_AGENT_PROFILES.has(agent.profile)) {
    throw new Error(
      `Config: agent '${name}' has invalid profile '${agent.profile}'`
    );
  }
}

function buildLegacyRolesFromAgents(rawAgents: any, agentNames: Set<string>): RoleConfigMap {
  const roles = emptyLegacyCompatibleRoleMap();

  for (const agent of agentNames) {
    const raw = rawAgents[agent] ?? {};
    const capability = raw.capability ?? 'host_allowed';
    const legacyProfile = raw.profile ?? 'normal';

    if (capability === 'disabled') continue;

    if (legacyProfile === 'restricted') {
      roles.owner.agents[agent] = 'readonly';
      roles.collaborator.agents[agent] = 'readonly';
      continue;
    }

    if (legacyProfile === 'trusted') {
      roles.owner.agents[agent] = 'trusted';
      continue;
    }

    roles.owner.agents[agent] = 'readwrite';
    roles.collaborator.agents[agent] = 'readwrite';
  }

  return roles;
}

function buildRolesConfig(
  rawRoles: any,
  agentNames: Set<string>,
  version: 1 | 2
): RoleConfigMap {
  if (typeof rawRoles !== 'object' || rawRoles === null || Array.isArray(rawRoles)) {
    throw new Error('Config: roles must be an object');
  }

  if (isLegacyRoleMatrixShape(rawRoles)) {
    if (version === 2) {
      throw new Error('Config: version 2 requires roles.<role>.agents and capabilities/superuser');
    }
    return convertLegacyRoleMatrix(rawRoles, agentNames);
  }

  const roles: RoleConfigMap = {};
  for (const [rawRoleId, rawRole] of Object.entries(rawRoles)) {
    validateRoleId(rawRoleId);
    if (typeof rawRole !== 'object' || rawRole === null || Array.isArray(rawRole)) {
      throw new Error(`Config: roles.${rawRoleId} must be an object`);
    }

    const role = rawRole as Record<string, unknown>;
    const agents = parseRoleAgents(rawRoleId, role.agents, agentNames);
    const hasSuperuser = role.superuser === true;
    const hasCapabilities = role.capabilities !== undefined;

    if (isOwnerRole(rawRoleId)) {
      if (!hasSuperuser) {
        throw new Error('Config: roles.owner.superuser must be true');
      }
      if (hasCapabilities) {
        throw new Error('Config: roles.owner cannot declare capabilities when superuser is true');
      }
      roles[rawRoleId] = { superuser: true, agents };
      continue;
    }

    if (hasSuperuser) {
      throw new Error(`Config: roles.${rawRoleId}.superuser is only allowed for owner`);
    }
    if (!hasCapabilities) {
      throw new Error(`Config: roles.${rawRoleId}.capabilities is required`);
    }
    roles[rawRoleId] = {
      capabilities: parseCapabilities(rawRoleId, role.capabilities),
      agents,
    };
  }

  if (!roles.owner) {
    throw new Error('Config: roles.owner is required');
  }

  return roles;
}

function parseRoleAgents(
  roleId: string,
  rawAgents: unknown,
  agentNames: Set<string>
): Record<string, AgentAccessProfile> {
  if (rawAgents === undefined) {
    return {};
  }
  if (typeof rawAgents !== 'object' || rawAgents === null || Array.isArray(rawAgents)) {
    throw new Error(`Config: roles.${roleId}.agents must be an object`);
  }

  const agents: Record<string, AgentAccessProfile> = {};
  for (const [agent, profile] of Object.entries(rawAgents)) {
    if (!agentNames.has(agent)) {
      throw new Error(`Config: roles.${roleId}.agents.${agent} references unknown agent '${agent}'`);
    }
    if (typeof profile !== 'string' || !VALID_ACCESS_PROFILES.has(profile)) {
      throw new Error(`Config: roles.${roleId}.agents.${agent} must be one of: readonly, draft, readwrite, trusted (got '${profile}')`);
    }
    agents[agent] = profile as AgentAccessProfile;
  }
  return agents;
}

function parseCapabilities(
  roleId: string,
  rawCapabilities: unknown
): Capability[] {
  if (!Array.isArray(rawCapabilities)) {
    throw new Error(`Config: roles.${roleId}.capabilities must be an array`);
  }

  const seen = new Set<Capability>();
  const capabilities: Capability[] = [];
  for (const capability of rawCapabilities) {
    if (capability === 'ALL') {
      throw new Error(`Config: roles.${roleId}.capabilities cannot use ALL; use superuser only for owner`);
    }
    if (typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability as Capability)) {
      throw new Error(`Config: roles.${roleId}.capabilities contains unknown capability '${capability}'`);
    }
    const typedCapability = capability as Capability;
    if (seen.has(typedCapability)) {
      throw new Error(`Config: roles.${roleId}.capabilities contains duplicate '${typedCapability}'`);
    }
    seen.add(typedCapability);
    capabilities.push(typedCapability);
  }
  return capabilities;
}

function validateRoleId(roleId: string): void {
  if (RESERVED_ROLE_IDS.has(roleId)) {
    throw new Error(`Config: role name '${roleId}' is reserved`);
  }
  if (!ROLE_ID_PATTERN.test(roleId)) {
    throw new Error(`Config: invalid role name '${roleId}'. Use lowercase letters, numbers, _ or -, max 32 chars`);
  }
}


function isLegacyRoleMatrixShape(rawRoles: Record<string, unknown>): boolean {
  const keys = Object.keys(rawRoles);
  if (keys.length === 0) return false;
  if (keys.some((key) => !LEGACY_ROLE_IDS.has(key))) return false;
  return keys.every((key) => {
    const rawRole = rawRoles[key];
    if (typeof rawRole !== 'object' || rawRole === null || Array.isArray(rawRole)) {
      return false;
    }
    return Object.values(rawRole).every((value) => typeof value === 'string' && VALID_ACCESS_PROFILES.has(value));
  });
}

function convertLegacyRoleMatrix(
  rawRoles: Record<string, unknown>,
  agentNames: Set<string>
): RoleConfigMap {
  const roles = emptyLegacyCompatibleRoleMap();

  for (const roleId of Object.keys(rawRoles)) {
    if (!LEGACY_ROLE_IDS.has(roleId)) {
      throw new Error(`Config: unknown legacy role '${roleId}'. Use owner, collaborator, or observer`);
    }
    const rawRole = rawRoles[roleId] as Record<string, unknown>;
    for (const [agent, profile] of Object.entries(rawRole)) {
      if (!agentNames.has(agent)) {
        throw new Error(`Config: roles.${roleId}.${agent} references unknown agent '${agent}'`);
      }
      if (typeof profile !== 'string' || !VALID_ACCESS_PROFILES.has(profile)) {
        throw new Error(`Config: roles.${roleId}.${agent} must be one of: readonly, draft, readwrite, trusted (got '${profile}')`);
      }
      roles[roleId].agents[agent] = profile as AgentAccessProfile;
    }
  }

  return roles;
}

function emptyLegacyCompatibleRoleMap(): RoleConfigMap & {
  owner: OwnerRoleConfig;
  collaborator: NonOwnerRoleConfig;
  observer: NonOwnerRoleConfig;
} {
  return {
    owner: { superuser: true, agents: {} },
    collaborator: { capabilities: [...LEGACY_COLLABORATOR_CAPABILITIES], agents: {} },
    observer: { capabilities: [...LEGACY_OBSERVER_CAPABILITIES], agents: {} },
  };
}

function buildSecurityConfig(raw: any): SecurityConfig {
  if (!raw) return { ...DEFAULT_SECURITY };

  if (typeof raw === 'object' && raw !== null) {
    for (const key of Object.keys(raw)) {
      if (!VALID_SECURITY_KEYS.has(key)) {
        throw new Error(`Config: unknown security key '${key}'`);
      }
    }
  }

  const sandbox = { ...DEFAULT_SECURITY.sandbox };
  if (raw.sandbox) {
    if (typeof raw.sandbox === 'object' && raw.sandbox !== null) {
      for (const key of Object.keys(raw.sandbox)) {
        if (!VALID_SANDBOX_KEYS.has(key)) {
          throw new Error(`Config: unknown security.sandbox key '${key}'`);
        }
      }
    }
    if (raw.sandbox.runner !== undefined) {
      if (!VALID_SANDBOX_RUNNERS.has(raw.sandbox.runner)) {
        throw new Error(
          `Config: security.sandbox.runner must be one of: ${[...VALID_SANDBOX_RUNNERS].join(', ')} (got '${raw.sandbox.runner}')`
        );
      }
      sandbox.runner = raw.sandbox.runner;
    }
    if (raw.sandbox.empty_home !== undefined) sandbox.empty_home = !!raw.sandbox.empty_home;
    if (raw.sandbox.private_tmp !== undefined) sandbox.private_tmp = !!raw.sandbox.private_tmp;
    if (raw.sandbox.forward_env !== undefined) {
      if (!Array.isArray(raw.sandbox.forward_env)) {
        throw new Error('Config: security.sandbox.forward_env must be an array');
      }
      sandbox.forward_env = raw.sandbox.forward_env;
    }
    if (raw.sandbox.container_image !== undefined) {
      if (typeof raw.sandbox.container_image !== 'string') {
        throw new Error('Config: security.sandbox.container_image must be a string');
      }
      sandbox.container_image = raw.sandbox.container_image;
    }
  }

  return { sandbox };
}

function normalizeOrigins(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  throw new Error('Config: server.cors_allowed_origins must be a string or list of strings');
}

function buildMigratedConfigDocument(parsed: any, config: TeepeeConfig): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Config: expected a YAML object');
  }

  const next = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  next.version = 2;
  next.roles = serializeRolesForV2(config.roles);
  delete next.filesystem;

  const rawAgents = typeof next.agents === 'object' && next.agents !== null && !Array.isArray(next.agents)
    ? next.agents as Record<string, Record<string, unknown>>
    : null;
  if (rawAgents) {
    for (const agent of Object.values(rawAgents)) {
      delete agent.profile;
      delete agent.capability;
    }
  }

  return next;
}

function needsV2ConfigNormalization(parsed: any): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  if (parsed.filesystem !== undefined) {
    return true;
  }

  const roles = parsed.roles;
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
    return false;
  }

  for (const roleId of ['collaborator', 'observer']) {
    const role = roles[roleId];
    if (typeof role !== 'object' || role === null || Array.isArray(role)) {
      continue;
    }
    const capabilities = (role as Record<string, unknown>).capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes('files.workspace.access')) {
      return true;
    }
  }

  return false;
}


function serializeRolesForV2(roles: RoleConfigMap): Record<string, Record<string, unknown>> {
  const serialized: Record<string, Record<string, unknown>> = {};

  for (const [roleId, role] of Object.entries(roles)) {
    if ('superuser' in role && role.superuser) {
      serialized[roleId] = {
        superuser: true,
        agents: { ...role.agents },
      };
      continue;
    }

    const capabilities = [...role.capabilities];
    if ((roleId === 'collaborator' || roleId === 'observer') && !capabilities.includes('files.workspace.access')) {
      capabilities.unshift('files.workspace.access');
    }

    serialized[roleId] = {
      capabilities,
      agents: { ...role.agents },
    };
  }

  return serialized;
}


function validateMigratedConfigOutput(configPath: string, output: string): void {
  const tmpPath = path.join(
    path.dirname(configPath),
    `.config.validate.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.yaml`
  );

  try {
    fs.writeFileSync(tmpPath, output, 'utf-8');
    const config = loadConfig(tmpPath);
    if (config.version !== 2) {
      throw new Error('Config migration validation failed: expected version 2');
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function nextAvailableBackupPath(configPath: string, sourceVersion: 1 | 2): string {
  const dir = path.dirname(configPath);
  const ext = path.extname(configPath) || '.yaml';
  const base = path.basename(configPath, ext);
  let candidate = path.join(dir, `${base}.v${sourceVersion}.bak${ext}`);
  let counter = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}.v${sourceVersion}.bak.${counter}${ext}`);
    counter += 1;
  }

  return candidate;
}

function writeFileAtomically(targetPath: string, content: string): void {
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}
