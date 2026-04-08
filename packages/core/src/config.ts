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

export type AgentCapability = 'host_allowed' | 'sandbox_only' | 'disabled';

export interface AgentConfig {
  provider: string;
  prompt?: string;
  timeout_seconds?: number;
  capability?: AgentCapability;
}

export type ExecutionMode = 'host' | 'sandbox' | 'disabled';

export interface SecurityConfig {
  role_defaults: {
    owner: ExecutionMode;
    user: ExecutionMode;
    observer: ExecutionMode;
  };
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
  role_defaults: {
    owner: 'host',
    user: 'sandbox',
    observer: 'disabled',
  },
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

  // Validate teepee section
  if (!parsed.teepee?.name) {
    throw new Error('Config: teepee.name is required');
  }

  const config: TeepeeConfig = {
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

    const capability = a.capability ?? 'host_allowed';
    if (!['host_allowed', 'sandbox_only', 'disabled'].includes(capability)) {
      throw new Error(
        `Config: agent '${name}' has invalid capability '${capability}'`
      );
    }

    config.agents[name] = {
      provider: a.provider,
      prompt: a.prompt,
      timeout_seconds: a.timeout_seconds,
      capability: capability as AgentCapability,
    };
  }

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

const VALID_EXECUTION_MODES = new Set<string>(['host', 'sandbox', 'disabled']);
const VALID_CAPABILITIES = new Set<string>(['host_allowed', 'sandbox_only', 'disabled']);
const VALID_SANDBOX_RUNNERS = new Set<string>(['bubblewrap', 'container']);

function validateExecutionMode(value: unknown, path: string): ExecutionMode {
  if (typeof value !== 'string' || !VALID_EXECUTION_MODES.has(value)) {
    throw new Error(`Config: ${path} must be one of: host, sandbox, disabled (got '${value}')`);
  }
  return value as ExecutionMode;
}

function buildSecurityConfig(raw: any): SecurityConfig {
  if (!raw) return { ...DEFAULT_SECURITY };

  const roleDefaults = { ...DEFAULT_SECURITY.role_defaults };
  if (raw.role_defaults) {
    for (const role of ['owner', 'user', 'observer'] as const) {
      if (raw.role_defaults[role] !== undefined) {
        roleDefaults[role] = validateExecutionMode(
          raw.role_defaults[role],
          `security.role_defaults.${role}`
        );
      }
    }
  }

  const sandbox = { ...DEFAULT_SECURITY.sandbox };
  if (raw.sandbox) {
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

  return { role_defaults: roleDefaults, sandbox };
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
