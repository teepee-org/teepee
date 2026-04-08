import type { Database as DatabaseType } from 'better-sqlite3';
import type { TeepeeConfig, ExecutionMode } from './config.js';
import { resolveTimeout } from './config.js';
import {
  insertMessage,
  insertMention,
  createBatch,
  createJob,
  updateJobStatus,
  countChainJobs,
  logUsage,
  emitEvent,
  getTopic,
  getUser,
} from './db.js';
import { parseMentions, resolveAliases } from './mentions.js';
import { filterAllowedAgents } from './permissions.js';
import { buildContext, runAgent } from './executor.js';
import { resolveExecutionPolicy, applyInsecureOverride, validateSandboxAvailability } from './execution-policy.js';
import type { UserRole } from './commands/types.js';
import type { SandboxRunner } from './sandbox/runner.js';
import { detectSandboxAvailability, type SandboxDetectionResult } from './sandbox/detect.js';

export interface OrchestratorCallbacks {
  onJobStarted(topicId: number, jobId: number, agentName: string): void;
  onJobStream(topicId: number, jobId: number, chunk: string): void;
  onJobCompleted(topicId: number, jobId: number, agentName: string, messageId: number): void;
  onJobFailed(topicId: number, jobId: number, agentName: string, error: string): void;
  onSystemMessage(topicId: number, text: string): void;
}

export interface OrchestratorOptions {
  insecure?: boolean;
}

export class Orchestrator {
  private db: DatabaseType;
  private config: TeepeeConfig;
  private basePath: string;
  private callbacks: OrchestratorCallbacks;
  private knownAgents: Set<string>;
  private sandboxRunner: SandboxRunner;
  private sandboxAvailable: boolean;
  private sandboxBackend: string;
  private insecure: boolean;

  // Track active jobs per agent per topic
  private activeJobs = new Map<string, Promise<void>>();

  constructor(
    db: DatabaseType,
    config: TeepeeConfig,
    basePath: string,
    callbacks: OrchestratorCallbacks,
    options: OrchestratorOptions = {}
  ) {
    this.db = db;
    this.config = config;
    this.basePath = basePath;
    this.callbacks = callbacks;
    this.insecure = options.insecure || false;
    this.knownAgents = new Set(Object.keys(config.agents));
    const sandbox = detectSandboxAvailability({
      preferredRunner: config.security.sandbox.runner,
    });
    this.sandboxRunner = sandbox.runner;
    this.sandboxAvailable = sandbox.available;
    this.sandboxBackend = sandbox.backend;
  }

  /**
   * Handle a new message posted by a user (inserts + orchestrates).
   */
  async handleMessage(
    topicId: number,
    userEmail: string,
    authorName: string,
    body: string
  ): Promise<number> {
    const messageId = insertMessage(this.db, topicId, 'user', authorName, body);
    await this.handlePostedMessage(topicId, messageId, userEmail, authorName, body);
    return messageId;
  }

  /**
   * Orchestrate agent jobs for an already-inserted message.
   */
  async handlePostedMessage(
    topicId: number,
    messageId: number,
    userEmail: string,
    _authorName: string,
    body: string
  ): Promise<void> {
    // Parse mentions
    const { active, quoted } = parseMentions(body);

    // Persist all mentions
    const resolvedActive = resolveAliases(this.db, topicId, active, this.knownAgents);
    for (const agent of resolvedActive) {
      insertMention(this.db, messageId, agent, true);
    }
    for (const agent of quoted) {
      insertMention(this.db, messageId, agent, false);
    }

    // Filter by known agents
    const validAgents = resolvedActive.filter((a) => this.knownAgents.has(a));

    if (validAgents.length === 0) return;

    // Enforce max_agents_per_message
    const limitedAgents = validAgents.slice(
      0,
      this.config.limits.max_agents_per_message
    );

    // Check permissions
    const { allowed, denied, rateLimited } = filterAllowedAgents(
      this.db,
      userEmail,
      limitedAgents,
      topicId,
      this.config.limits
    );

    if (rateLimited) {
      const sysMsg = `Rate limit reached. Try again later.`;
      insertMessage(this.db, topicId, 'system', 'teepee', sysMsg);
      this.callbacks.onSystemMessage(topicId, sysMsg);
      return;
    }

    if (denied.length > 0) {
      const sysMsg = `Permission denied for: ${denied.map((a) => '@' + a).join(', ')}`;
      insertMessage(this.db, topicId, 'system', 'teepee', sysMsg);
      this.callbacks.onSystemMessage(topicId, sysMsg);
    }

    if (allowed.length === 0) return;

    // Create batch and execute
    await this.executeBatch(topicId, messageId, allowed, userEmail, null, 0);
  }

  private async executeBatch(
    topicId: number,
    triggerMessageId: number,
    agents: string[],
    userEmail: string,
    chainRootBatchId: number | null,
    chainDepth: number,
    requesterRole?: UserRole
  ): Promise<void> {
    const batchId = createBatch(
      this.db,
      triggerMessageId,
      chainRootBatchId,
      chainDepth
    );
    const rootId = chainRootBatchId ?? batchId;

    // Check total chain jobs
    const totalJobs = countChainJobs(this.db, rootId);
    if (totalJobs >= this.config.limits.max_total_jobs_per_chain) {
      const sysMsg = 'Chain job limit reached.';
      insertMessage(this.db, topicId, 'system', 'teepee', sysMsg);
      this.callbacks.onSystemMessage(topicId, sysMsg);
      return;
    }

    // Resolve requester role (once per batch, inherited by chains)
    const role: UserRole = requesterRole ?? this.resolveUserRole(userEmail);

    // Create jobs
    const jobIds = agents.map((agent) => ({
      id: createJob(this.db, batchId, agent),
      agent,
    }));

    // Resolve language
    const topic = getTopic(this.db, topicId);
    const language = topic?.language ?? this.config.teepee.language;

    // Execute in parallel
    const promises = jobIds.map(({ id: jobId, agent }) =>
      this.executeJob(
        jobId,
        agent,
        topicId,
        triggerMessageId,
        language,
        userEmail,
        rootId,
        chainDepth,
        role
      )
    );

    await Promise.all(promises);
  }

  private resolveUserRole(email: string): UserRole {
    const user = getUser(this.db, email);
    if (!user) return 'observer';
    if (user.role === 'owner') return 'owner';
    if (user.role === 'observer') return 'observer';
    return 'user';
  }

  private async executeJob(
    jobId: number,
    agentName: string,
    topicId: number,
    triggerMessageId: number,
    language: string,
    userEmail: string,
    chainRootBatchId: number,
    chainDepth: number,
    requesterRole: UserRole
  ): Promise<void> {
    // Wait for any active job for this agent in this topic
    const key = `${agentName}:${topicId}`;
    const prev = this.activeJobs.get(key);
    if (prev) await prev;

    const jobPromise = this.runJob(
      jobId,
      agentName,
      topicId,
      triggerMessageId,
      language,
      userEmail,
      chainRootBatchId,
      chainDepth,
      requesterRole
    );
    this.activeJobs.set(key, jobPromise);

    try {
      await jobPromise;
    } finally {
      if (this.activeJobs.get(key) === jobPromise) {
        this.activeJobs.delete(key);
      }
    }
  }

  private async runJob(
    jobId: number,
    agentName: string,
    topicId: number,
    triggerMessageId: number,
    language: string,
    userEmail: string,
    chainRootBatchId: number,
    chainDepth: number,
    requesterRole: UserRole
  ): Promise<void> {
    // Resolve execution policy
    const agentConfig = this.config.agents[agentName];
    const providerConfig = this.config.providers[agentConfig.provider];
    let policy = resolveExecutionPolicy(
      requesterRole,
      agentConfig.capability,
      this.config.security
    );

    // In insecure mode, promote sandbox to host
    if (this.insecure) {
      policy = applyInsecureOverride(policy);
    }

    // Record execution metadata
    const effectiveMode: ExecutionMode = policy.mode;

    // Block disabled agents — persist audit metadata even on denial
    if (effectiveMode === 'disabled') {
      const error = `Agent '${agentName}' is disabled: ${policy.reason}`;
      updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, effective_mode: effectiveMode });
      emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, effective_mode: effectiveMode }));
      this.callbacks.onJobFailed(topicId, jobId, agentName, error);
      return;
    }

    // Validate sandbox availability when required — persist audit metadata on fail-closed
    if (effectiveMode === 'sandbox') {
      const sandboxError = validateSandboxAvailability(effectiveMode, this.sandboxAvailable);
      if (sandboxError) {
        const error = sandboxError;
        updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, effective_mode: effectiveMode });
        emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, effective_mode: effectiveMode }));
        this.callbacks.onJobFailed(topicId, jobId, agentName, error);
        return;
      }

      if (this.sandboxRunner.name === 'container' && !providerConfig.sandbox?.image) {
        const error = `Sandbox backend 'container' requires provider '${agentConfig.provider}' to define providers.${agentConfig.provider}.sandbox.image`;
        updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, effective_mode: effectiveMode });
        emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, effective_mode: effectiveMode }));
        this.callbacks.onJobFailed(topicId, jobId, agentName, error);
        return;
      }
    }

    // Start
    updateJobStatus(this.db, jobId, 'running', { requested_by_email: userEmail, effective_mode: effectiveMode });
    emitEvent(this.db, 'agent.job.started', topicId, JSON.stringify({
      job_id: jobId, agent: agentName, requested_by: userEmail, effective_mode: effectiveMode,
      sandbox_backend: effectiveMode === 'sandbox' ? this.sandboxBackend : undefined,
    }));
    this.callbacks.onJobStarted(topicId, jobId, agentName);
    logUsage(this.db, userEmail, agentName, jobId);

    // Build context
    const context = buildContext(
      this.db,
      agentName,
      topicId,
      triggerMessageId,
      language,
      this.config,
      this.basePath
    );

    // Run
    const command = providerConfig.command;
    const timeoutMs = resolveTimeout(agentName, this.config);

    // Build sandbox options with provider-specific overrides for container backend
    const sandboxOptions = effectiveMode === 'sandbox' ? {
      projectRoot: this.basePath,
      emptyHome: this.config.security.sandbox.empty_home,
      privateTmp: this.config.security.sandbox.private_tmp,
      forwardEnv: this.config.security.sandbox.forward_env,
      containerImage: this.sandboxRunner.name === 'container' ? providerConfig.sandbox?.image : undefined,
      containerCommand: this.sandboxRunner.name === 'container'
        ? (providerConfig.sandbox?.command ?? providerConfig.command)
        : undefined,
    } : undefined;

    const result = await runAgent({
      command,
      context,
      timeoutMs,
      cwd: this.basePath,
      executionMode: effectiveMode,
      sandboxRunner: effectiveMode === 'sandbox' ? this.sandboxRunner : undefined,
      sandboxOptions,
      onChunk: (chunk) => {
        this.callbacks.onJobStream(topicId, jobId, chunk);
      },
    });

    if (result.timedOut) {
      const error = `Timeout after ${timeoutMs / 1000}s`;
      updateJobStatus(this.db, jobId, 'failed', { error });
      emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error }));
      this.callbacks.onJobFailed(topicId, jobId, agentName, error);
      return;
    }

    if (result.exitCode !== 0 || !result.output) {
      const error = result.output || `Exit code ${result.exitCode}`;
      updateJobStatus(this.db, jobId, 'failed', { error });
      emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error }));
      this.callbacks.onJobFailed(topicId, jobId, agentName, error);
      return;
    }

    // Persist reply
    const outputMessageId = insertMessage(
      this.db,
      topicId,
      'agent',
      agentName,
      result.output
    );
    updateJobStatus(this.db, jobId, 'done', {
      output_message_id: outputMessageId,
    });
    emitEvent(this.db, 'agent.job.completed', topicId, JSON.stringify({ job_id: jobId, agent: agentName }));
    this.callbacks.onJobCompleted(topicId, jobId, agentName, outputMessageId);

    // Check for chaining
    if (chainDepth < this.config.limits.max_chain_depth) {
      const { active } = parseMentions(result.output);
      const resolved = resolveAliases(this.db, topicId, active, this.knownAgents);
      const chainAgents = resolved.filter(
        (a) => this.knownAgents.has(a) && a !== agentName
      );

      if (chainAgents.length > 0) {
        // Persist chain mentions
        for (const agent of chainAgents) {
          insertMention(this.db, outputMessageId, agent, true);
        }

        // Chain inherits the original requester's role — never escalates
        await this.executeBatch(
          topicId,
          outputMessageId,
          chainAgents,
          userEmail,
          chainRootBatchId,
          chainDepth + 1,
          requesterRole
        );
      }
    }
  }
}
