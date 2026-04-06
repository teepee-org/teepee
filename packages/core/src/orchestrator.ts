import type { Database as DatabaseType } from 'better-sqlite3';
import type { TeepeeConfig } from './config.js';
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
} from './db.js';
import { parseMentions, resolveAliases } from './mentions.js';
import { filterAllowedAgents } from './permissions.js';
import { buildContext, runAgent } from './executor.js';

export interface OrchestratorCallbacks {
  onJobStarted(topicId: number, jobId: number, agentName: string): void;
  onJobStream(topicId: number, jobId: number, chunk: string): void;
  onJobCompleted(topicId: number, jobId: number, agentName: string, messageId: number): void;
  onJobFailed(topicId: number, jobId: number, agentName: string, error: string): void;
  onSystemMessage(topicId: number, text: string): void;
}

export class Orchestrator {
  private db: DatabaseType;
  private config: TeepeeConfig;
  private basePath: string;
  private callbacks: OrchestratorCallbacks;
  private knownAgents: Set<string>;

  // Track active jobs per agent per topic
  private activeJobs = new Map<string, Promise<void>>();

  constructor(
    db: DatabaseType,
    config: TeepeeConfig,
    basePath: string,
    callbacks: OrchestratorCallbacks
  ) {
    this.db = db;
    this.config = config;
    this.basePath = basePath;
    this.callbacks = callbacks;
    this.knownAgents = new Set(Object.keys(config.agents));
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
    chainDepth: number
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
        chainDepth
      )
    );

    await Promise.all(promises);
  }

  private async executeJob(
    jobId: number,
    agentName: string,
    topicId: number,
    triggerMessageId: number,
    language: string,
    userEmail: string,
    chainRootBatchId: number,
    chainDepth: number
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
      chainDepth
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
    chainDepth: number
  ): Promise<void> {
    // Start
    updateJobStatus(this.db, jobId, 'running');
    emitEvent(this.db, 'agent.job.started', topicId, JSON.stringify({ job_id: jobId, agent: agentName }));
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
    const command = this.config.providers[this.config.agents[agentName].provider].command;
    const timeoutMs = resolveTimeout(agentName, this.config);

    const result = await runAgent(command, context, timeoutMs, this.basePath, (chunk) => {
      this.callbacks.onJobStream(topicId, jobId, chunk);
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

        await this.executeBatch(
          topicId,
          outputMessageId,
          chainAgents,
          userEmail,
          chainRootBatchId,
          chainDepth + 1
        );
      }
    }
  }
}
