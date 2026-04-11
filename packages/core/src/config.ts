import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface ProviderSandboxConfig {
  /** Container image that includes the provider CLI. */
  image: string;
  /** Command to run inside the container (defaults to provider.command). */
  command?: string;
}

export interface ProviderConfig {
  command: string;
  timeout_seconds?: number;
  /** Sandbox runtime config for container-based execution. */
  sandbox?: ProviderSandboxConfig;
}

export type UserRole = 'owner' | 'collaborator' | 'observer';

export type TeepeeMode = 'private' | 'shared';

export type AgentAccessProfile = 'readonly' | 'draft' | 'readwrite' | 'trusted';

/** @deprecated Use AgentAccessProfile. */
export type AgentProfile = AgentAccessProfile;

export type RoleAgentMatrix = Record<UserRole, Record<string, AgentAccessProfile>>;

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

export interface TeepeeConfig {
  version: 1;
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
  roles: RoleAgentMatrix;
  limits: LimitsConfig;
  security: SecurityConfig;
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

const DEFAULT_SECURITY: SecurityConfig = {
  sandbox: {
    runner: 'bubblewrap',
    empty_home: true,
    private_tmp: true,
    forward_env: [],
  },
};

export function loadConfig(configPath: string): TeepeeConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  validateTopLevelSecurityKeys(parsed);
  const version = parseConfigVersion(parsed.version);
  const mode = parseConfigMode(parsed.mode);

  // Validate teepee section
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
    roles: { owner: {}, collaborator: {}, observer: {} },
    limits: { ...DEFAULT_LIMITS, ...parsed.limits },
    security: buildSecurityConfig(parsed.security),
  };

  // Validate providers
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

  // Validate agents
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
        throw new Error(`Config: agent '${name}' uses legacy 'profile'; move access profiles to roles.<role>.${name}`);
      }
      if (a.capability !== undefined) {
        throw new Error(`Config: agent '${name}' uses legacy 'capability'; omit the agent from roles to deny access`);
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
    ? buildRoleAgentMatrix(parsed.roles, agentNames)
    : buildLegacyRoleAgentMatrix(parsed.agents, agentNames);

  return config;
}

export function resolvePrompt(
  agentName: string,
  agentConfig: AgentConfig,
  basePath: string
): string {
  // Explicit prompt file
  if (agentConfig.prompt) {
    const promptPath = path.resolve(basePath, agentConfig.prompt);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    throw new Error(
      `Prompt file not found for agent '${agentName}': ${promptPath}`
    );
  }

  // Default prompt by agent name
  const namedDefault = path.resolve(
    basePath,
    'default-prompts',
    `${agentName}.md`
  );
  if (fs.existsSync(namedDefault)) {
    return fs.readFileSync(namedDefault, 'utf-8');
  }

  // Fallback default
  const fallback = path.resolve(basePath, 'default-prompts', 'default.md');
  if (fs.existsSync(fallback)) {
    return fs.readFileSync(fallback, 'utf-8');
  }

  return `You are ${agentName}, an AI assistant.`;
}

export function resolveTimeout(
  agentName: string,
  config: TeepeeConfig
): number {
  const agent = config.agents[agentName];
  if (agent?.timeout_seconds) return agent.timeout_seconds * 1000;
  const provider = config.providers[agent?.provider];
  if (provider?.timeout_seconds) return provider.timeout_seconds * 1000;
  return 120_000;
}

const VALID_LEGACY_CAPABILITIES = new Set<string>(['host_allowed', 'sandbox_only', 'disabled']);
const VALID_LEGACY_AGENT_PROFILES = new Set<string>(['restricted', 'normal', 'trusted']);
const VALID_ACCESS_PROFILES = new Set<string>(['readonly', 'draft', 'readwrite', 'trusted']);
const VALID_CHAIN_POLICIES = new Set<string>(['none', 'propose_only', 'delegate_with_origin_policy']);
const VALID_SANDBOX_RUNNERS = new Set<string>(['bubblewrap', 'container']);
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

function parseConfigVersion(value: unknown): 1 {
  if (value === undefined || value === null) return 1;
  if (value !== 1) {
    throw new Error(`Config: version must be 1 (got '${value}')`);
  }
  return 1;
}

function parseConfigMode(value: unknown): TeepeeMode {
  if (value === undefined || value === null) return 'private';
  if (value === 'private' || value === 'shared') return value;
  throw new Error(`Config: mode must be 'private' or 'shared' (got '${value}')`);
}

const VALID_SECURITY_KEYS = new Set(['sandbox']);
const VALID_SANDBOX_KEYS = new Set(['runner', 'empty_home', 'private_tmp', 'forward_env', 'container_image']);
const USER_ROLES = ['owner', 'collaborator', 'observer'] as const;

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

function buildLegacyRoleAgentMatrix(rawAgents: any, agentNames: Set<string>): RoleAgentMatrix {
  const roles = emptyRoleAgentMatrix();

  for (const agent of agentNames) {
    const raw = rawAgents[agent] ?? {};
    const capability = raw.capability ?? 'host_allowed';
    const legacyProfile = raw.profile ?? 'normal';

    if (capability === 'disabled') continue;

    if (legacyProfile === 'restricted') {
      roles.owner[agent] = 'readonly';
      roles.collaborator[agent] = 'readonly';
      continue;
    }

    if (legacyProfile === 'trusted') {
      roles.owner[agent] = 'trusted';
      continue;
    }

    roles.owner[agent] = 'readwrite';
    roles.collaborator[agent] = 'readwrite';
  }

  return roles;
}

function buildRoleAgentMatrix(rawRoles: any, agentNames: Set<string>): RoleAgentMatrix {
  if (typeof rawRoles !== 'object' || rawRoles === null || Array.isArray(rawRoles)) {
    throw new Error('Config: roles must be an object mapping owner/collaborator/observer to agents');
  }

  const roles = emptyRoleAgentMatrix();
  for (const role of USER_ROLES) {
    const rawRole = rawRoles[role];
    if (rawRole === undefined) continue;
    if (typeof rawRole !== 'object' || rawRole === null || Array.isArray(rawRole)) {
      throw new Error(`Config: roles.${role} must be an object`);
    }

    for (const [agent, profile] of Object.entries(rawRole)) {
      if (!agentNames.has(agent)) {
        throw new Error(`Config: roles.${role}.${agent} references unknown agent '${agent}'`);
      }
      if (typeof profile !== 'string' || !VALID_ACCESS_PROFILES.has(profile)) {
        throw new Error(`Config: roles.${role}.${agent} must be one of: readonly, draft, readwrite, trusted (got '${profile}')`);
      }
      roles[role][agent] = profile as AgentAccessProfile;
    }
  }

  for (const key of Object.keys(rawRoles)) {
    if (!USER_ROLES.includes(key as UserRole)) {
      throw new Error(`Config: unknown roles key '${key}'. Use owner, collaborator, or observer`);
    }
  }

  return roles;
}

function emptyRoleAgentMatrix(): RoleAgentMatrix {
  return { owner: {}, collaborator: {}, observer: {} };
}

export function resolveRoleAgentProfile(
  config: TeepeeConfig,
  role: UserRole,
  agentName: string
): AgentAccessProfile | null {
  if (!config.agents[agentName]) return null;
  const roleMatrix = config.roles[role];
  if (!roleMatrix) return null;
  return roleMatrix[agentName] ?? null;
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
