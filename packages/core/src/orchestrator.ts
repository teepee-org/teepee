import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { TeepeeConfig, ExecutionMode, AgentAccessProfile, UserRole } from './config.js';
import { hasCapability, normalizeConfiguredRole, resolveRoleAgentProfile, resolveTimeout, resolveKillGrace } from './config.js';
import type { StreamEvent } from './stream-parsers.js';
import {
  insertMessage,
  insertMention,
  createBatch,
  createJob,
  updateJobStatus,
  markJobWaitingInput,
  markJobResumed,
  cancelJob,
  getJob,
  countChainJobs,
  logUsage,
  emitEvent,
  getTopic,
  getUser,
  getUserById,
} from './db.js';
import { listScopedArtifactContext } from './db/artifacts.js';
import { getTopicLineage } from './db/topics.js';
import { parseMentions, resolveAliases } from './mentions.js';
import { filterAllowedAgents } from './permissions.js';
import { buildContext, runAgent, type JobResult } from './executor.js';
import { buildSandboxAuthMountPlan, buildSandboxCommandMountPlan } from './command.js';
import { resolveExecutionPolicy, validateJobRunPreconditions } from './execution-policy.js';
import {
  commitPreparedArtifactIngest,
  formatIngestSummary,
  prepareArtifactIngest,
  type IngestErrorDetail,
  type PreparedArtifactIngest,
} from './artifacts/ingest.js';
import {
  MAX_ARTIFACT_OP_ROUNDS,
  executeArtifactOps,
  formatArtifactOpResults,
  readArtifactOpsFile,
  validateArtifactOps,
  type ArtifactReadAccessState,
} from './artifacts/ops.js';
import type { SandboxRunner, SandboxOptions } from './sandbox/runner.js';
import { detectSandboxAvailability } from './sandbox/detect.js';
import {
  createJobInputRequest,
  getJobInputRequestById,
  getPendingJobInputRequest,
  answerJobInputRequest,
  cancelJobInputRequest,
  formatUserInputResults,
  readUserInputFile,
  validateUserInputRequest,
  validateUserInputResponse,
  type JobInputRequestPayload,
} from './user-input/index.js';

export interface OrchestratorCallbacks {
  onJobStarted(topicId: number, jobId: number, agentName: string): void;
  onJobStream(topicId: number, jobId: number, chunk: string): void;
  onJobRetrying(topicId: number, jobId: number, agentName: string, attempt: number, error: string): void;
  onJobRoundStarted(topicId: number, jobId: number, agentName: string, round: number, phase: string): void;
  onJobActivity(topicId: number, jobId: number, agentName: string, event: StreamEvent): void;
  onJobWaitingInput(topicId: number, jobId: number, agentName: string, request: JobInputRequestPayload): void;
  onJobResumed(topicId: number, jobId: number, agentName: string, requestId: number, answeredByUserId: string): void;
  onJobCompleted(topicId: number, jobId: number, agentName: string, messageId: number): void;
  onJobFailed(topicId: number, jobId: number, agentName: string, error: string, options?: { timedOut?: boolean }): void;
  onSystemMessage(topicId: number, messageId: number, text: string): void;
  onRuntimeChanged?(topicId: number): void;
}

const MAX_ARTIFACT_REPAIR_ROUNDS = 1;

interface PendingJobRow {
  job_id: number;
  batch_id: number;
  agent_name: string;
  status: string;
  requested_by_email: string | null;
  requested_by_user_id: string | null;
  effective_mode: ExecutionMode | null;
  effective_profile: AgentAccessProfile | null;
  trigger_message_id: number;
  chain_root_batch_id: number;
  chain_depth: number;
  topic_id: number;
  language: string | null;
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
  private schedulerDrainPromise: Promise<void> | null = null;
  private schedulerNeedsRerun = false;
  private activeWriterChainRootId: number | null = null;
  private runningJobs = new Map<number, Promise<void>>();
  private readonly outputNamespace: string;

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
    this.outputNamespace = createHash('sha1')
      .update(path.resolve(basePath))
      .digest('hex')
      .slice(0, 12);
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
      this.config.limits,
      this.config
    );

    if (rateLimited) {
      this.insertSystemMessage(topicId, `Rate limit reached. Try again later.`);
      return;
    }

    if (denied.length > 0) {
      this.insertSystemMessage(
        topicId,
        `Permission denied for: ${denied.map((a) => '@' + a).join(', ')}`
      );
    }

    if (allowed.length === 0) return;

    const rootId = await this.enqueueBatch(topicId, messageId, allowed, userEmail, null, 0, undefined, limitedAgents.length > 1);
    if (rootId !== null) {
      await this.waitForChainToPauseOrFinish(rootId);
    }
  }

  private async enqueueBatch(
    topicId: number,
    triggerMessageId: number,
    agents: string[],
    userEmail: string,
    chainRootBatchId: number | null,
    chainDepth: number,
    requesterRole?: UserRole,
    forceReadonlyBatch: boolean = agents.length > 1
  ): Promise<number | null> {
    const requesterUserId = getUser(this.db, userEmail)?.id ?? null;

    const inheritedRole: UserRole = requesterRole ?? this.resolveUserRole(userEmail);
    const existingChainJobs = chainRootBatchId ? countChainJobs(this.db, chainRootBatchId) : 0;
    if (existingChainJobs + agents.length > this.config.limits.max_total_jobs_per_chain) {
      this.insertSystemMessage(topicId, 'Chain job limit reached.');
      return null;
    }

    const batchId = createBatch(
      this.db,
      triggerMessageId,
      chainRootBatchId,
      chainDepth
    );
    const rootId = chainRootBatchId ?? batchId;
    if (chainRootBatchId !== null) {
      this.activeWriterChainRootId = chainRootBatchId;
    }

    for (const agent of agents) {
      const resolvedProfile = resolveRoleAgentProfile(this.config, inheritedRole, agent);
      const effectiveProfile = forceReadonlyBatch ? 'readonly' : resolvedProfile;
      const policy = resolveExecutionPolicy(effectiveProfile);
      createJob(this.db, batchId, agent, {
        requested_by_email: userEmail,
        requested_by_user_id: requesterUserId,
        effective_mode: policy.mode,
        effective_profile: effectiveProfile,
      });
    }

    this.callbacks.onRuntimeChanged?.(topicId);
    await this.drainScheduler();
    return rootId;
  }

  private async waitForChainToPauseOrFinish(chainRootBatchId: number): Promise<void> {
    for (;;) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt
           FROM jobs j
           JOIN invocation_batches b ON b.id = j.batch_id
          WHERE COALESCE(b.chain_root_batch_id, b.id) = ?
            AND j.status IN ('queued', 'running')`
      ).get(chainRootBatchId) as { cnt: number };
      if (Number(row?.cnt ?? 0) === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private resolveUserRole(email: string): UserRole {
    const user = getUser(this.db, email);
    if (!user) return '__missing__';
    return normalizeConfiguredRole(user.role);
  }

  private getJobOutputRoot(jobId: number): string {
    return path.join(os.tmpdir(), 'teepee', this.outputNamespace, 'jobs', String(jobId));
  }

  private getJobOutputDir(jobId: number): string {
    return path.join(this.getJobOutputRoot(jobId), 'out');
  }

  private async drainScheduler(): Promise<void> {
    if (this.schedulerDrainPromise) {
      this.schedulerNeedsRerun = true;
      await this.schedulerDrainPromise;
      return;
    }

    do {
      this.schedulerNeedsRerun = false;
      this.schedulerDrainPromise = this.runSchedulerLoop().finally(() => {
        this.schedulerDrainPromise = null;
      });
      await this.schedulerDrainPromise;
    } while (this.schedulerNeedsRerun);
  }

  private async runSchedulerLoop(): Promise<void> {
    for (;;) {
      const started = this.startSchedulableJobs();
      if (!started) {
        return;
      }
      await Promise.resolve();
    }
  }

  private startSchedulableJobs(): boolean {
    const runningWriter = this.findRunningWriterJob();
    if (runningWriter) {
      this.activeWriterChainRootId = runningWriter.chain_root_batch_id;
      return this.startJobsForScope(runningWriter.chain_root_batch_id);
    }

    if (this.activeWriterChainRootId !== null) {
      if (this.hasPendingJobsForChain(this.activeWriterChainRootId)) {
        return this.startJobsForScope(this.activeWriterChainRootId);
      }
      this.activeWriterChainRootId = null;
      return true;
    }

    return this.startJobsForScope(null);
  }

  private startJobsForScope(chainRootBatchId: number | null): boolean {
    const pending = this.listPendingJobs(chainRootBatchId);
    if (pending.length === 0) {
      return false;
    }

    const firstWriterIndex = pending.findIndex((job) => isWriteProfile(job.effective_profile));
    const readablePrefix = firstWriterIndex === -1
      ? pending
      : pending.slice(0, firstWriterIndex);

    const queuedReaders = readablePrefix.filter((job) => job.status === 'queued');
    if (queuedReaders.length > 0) {
      for (const job of queuedReaders) {
        this.startQueuedJob(job);
      }
      return true;
    }

    if (firstWriterIndex !== -1) {
      const firstWriter = pending[firstWriterIndex];
      if (firstWriter.status === 'queued' && firstWriterIndex === 0) {
        this.activeWriterChainRootId = firstWriter.chain_root_batch_id;
        this.startQueuedJob(firstWriter);
        return true;
      }
    }

    return false;
  }

  private startQueuedJob(job: PendingJobRow): void {
    updateJobStatus(this.db, job.job_id, 'running', {
      requested_by_email: job.requested_by_email ?? undefined,
      requested_by_user_id: job.requested_by_user_id ?? undefined,
      effective_mode: job.effective_mode ?? undefined,
      effective_profile: job.effective_profile ?? undefined,
      waiting_request_id: null,
    });
    this.callbacks.onRuntimeChanged?.(job.topic_id);

    const requesterRole = this.resolveUserRole(
      job.requested_by_email ?? getUserByIdOrThrow(this.db, job.requested_by_user_id!).email
    );
    const language = job.language ?? this.config.teepee.language;
    const effectiveMode = (job.effective_mode ?? 'disabled') as ExecutionMode;
    const effectiveProfile = job.effective_profile;

    const jobPromise = this.runJob({
      jobId: job.job_id,
      agentName: job.agent_name,
      topicId: job.topic_id,
      triggerMessageId: job.trigger_message_id,
      language,
      userEmail: job.requested_by_email ?? getUserByIdOrThrow(this.db, job.requested_by_user_id!).email,
      requesterUserId: job.requested_by_user_id,
      chainRootBatchId: job.chain_root_batch_id,
      chainDepth: job.chain_depth,
      requesterRole,
      effectiveMode,
      effectiveProfile,
    }).finally(() => {
      this.runningJobs.delete(job.job_id);
      this.callbacks.onRuntimeChanged?.(job.topic_id);
      void this.drainScheduler();
    });

    this.runningJobs.set(job.job_id, jobPromise);
    void jobPromise;
  }

  private listPendingJobs(chainRootBatchId: number | null): PendingJobRow[] {
    const scopedWhere = chainRootBatchId === null
      ? ''
      : 'AND COALESCE(b.chain_root_batch_id, b.id) = ?';
    return this.db.prepare(
      `SELECT
         j.id as job_id,
         j.batch_id,
         j.agent_name,
         j.status,
         j.requested_by_email,
         j.requested_by_user_id,
         j.effective_mode,
         j.effective_profile,
         b.trigger_message_id,
         COALESCE(b.chain_root_batch_id, b.id) as chain_root_batch_id,
         b.chain_depth,
         t.id as topic_id,
         t.language
       FROM jobs j
       JOIN invocation_batches b ON b.id = j.batch_id
       JOIN messages m ON m.id = b.trigger_message_id
       JOIN topics t ON t.id = m.topic_id
      WHERE j.status IN ('queued', 'running', 'waiting_input')
        ${scopedWhere}
      ORDER BY j.id ASC`
    ).all(...(chainRootBatchId === null ? [] : [chainRootBatchId])) as PendingJobRow[];
  }

  private findRunningWriterJob(): PendingJobRow | null {
    return this.db.prepare(
      `SELECT
         j.id as job_id,
         j.batch_id,
         j.agent_name,
         j.status,
         j.requested_by_email,
         j.requested_by_user_id,
         j.effective_mode,
         j.effective_profile,
         b.trigger_message_id,
         COALESCE(b.chain_root_batch_id, b.id) as chain_root_batch_id,
         b.chain_depth,
         t.id as topic_id,
         t.language
       FROM jobs j
       JOIN invocation_batches b ON b.id = j.batch_id
       JOIN messages m ON m.id = b.trigger_message_id
       JOIN topics t ON t.id = m.topic_id
      WHERE j.status IN ('running', 'waiting_input')
        AND j.effective_profile IN ('readwrite', 'trusted')
      ORDER BY j.id ASC
      LIMIT 1`
    ).get() as PendingJobRow | null;
  }

  private hasPendingJobsForChain(chainRootBatchId: number): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
         FROM jobs j
         JOIN invocation_batches b ON b.id = j.batch_id
        WHERE COALESCE(b.chain_root_batch_id, b.id) = ?
          AND j.status IN ('queued', 'running', 'waiting_input')`
    ).get(chainRootBatchId) as { cnt: number };
    return Number(row?.cnt ?? 0) > 0;
  }

  private async runJob(params: {
    jobId: number;
    agentName: string;
    topicId: number;
    triggerMessageId: number;
    language: string;
    userEmail: string;
    requesterUserId: string | null;
    chainRootBatchId: number;
    chainDepth: number;
    requesterRole: UserRole;
    effectiveMode: ExecutionMode;
    effectiveProfile: AgentAccessProfile | null;
  }): Promise<void> {
    const agentConfig = this.config.agents[params.agentName];
    const providerConfig = this.config.providers[agentConfig.provider];
    const policy = resolveExecutionPolicy(params.effectiveProfile);

    // Fail-closed preflight — identical checks on initial start and resume
    const preflightError = validateJobRunPreconditions({
      agentName: params.agentName,
      providerName: agentConfig.provider,
      effectiveMode: params.effectiveMode,
      policyReason: policy.reason,
      sandboxAvailable: this.sandboxAvailable,
      sandboxRunnerName: this.sandboxRunner.name,
      providerSandboxImage: providerConfig.sandbox?.image,
    });
    if (preflightError) {
      updateJobStatus(this.db, params.jobId, 'failed', { error: preflightError, requested_by_email: params.userEmail, requested_by_user_id: params.requesterUserId ?? undefined, effective_mode: params.effectiveMode, effective_profile: params.effectiveProfile });
      emitEvent(this.db, 'agent.job.failed', params.topicId, JSON.stringify({ job_id: params.jobId, agent: params.agentName, error: preflightError, requested_by: params.userEmail, requester_role: params.requesterRole, effective_mode: params.effectiveMode, effective_profile: params.effectiveProfile }));
      this.callbacks.onJobFailed(params.topicId, params.jobId, params.agentName, preflightError);
      return;
    }

    // Create per-job output directory
    const jobOutputDir = this.getJobOutputDir(params.jobId);
    fs.mkdirSync(path.join(jobOutputDir, 'files'), { recursive: true });

    try {
    emitEvent(this.db, 'agent.job.started', params.topicId, JSON.stringify({
      job_id: params.jobId, agent: params.agentName, requested_by: params.userEmail, requester_role: params.requesterRole, effective_mode: params.effectiveMode, effective_profile: params.effectiveProfile,
      sandbox_backend: params.effectiveMode === 'sandbox' ? this.sandboxBackend : undefined,
    }));
    this.callbacks.onJobStarted(params.topicId, params.jobId, params.agentName);
    logUsage(this.db, params.userEmail, params.agentName, params.jobId);

    const command = providerConfig.command;
    if (params.effectiveMode === 'db_only') {
      const result = runDbOnlyAgent(providerConfig.command);
      await this.completeJobFromResult(
        result,
        params.jobId,
        params.agentName,
        params.topicId,
        params.userEmail,
        params.requesterUserId,
        params.chainRootBatchId,
        params.chainDepth,
        params.requesterRole,
        policy.canWriteArtifacts ? jobOutputDir : undefined
      );
      return;
    }

    const topicLineage = getTopicLineage(this.db, params.topicId);
    const topicArtifacts = policy.canWriteArtifacts
      ? listScopedArtifactContext(this.db, topicLineage)
      : undefined;

    const needsSandbox = params.effectiveMode === 'sandbox';
    const providerSandboxPlan = needsSandbox && this.sandboxRunner.name === 'bubblewrap'
      ? buildSandboxCommandMountPlan(command)
      : null;
    const providerAuthMounts = needsSandbox && this.sandboxRunner.name === 'bubblewrap'
      ? buildSandboxAuthMountPlan(command)
      : [];
    const sandboxOptions = needsSandbox ? {
      projectRoot: this.basePath,
      readOnlyProject: policy.sandboxReadOnly,
      emptyHome: this.config.security.sandbox.empty_home,
      privateTmp: this.config.security.sandbox.private_tmp,
      forwardEnv: this.config.security.sandbox.forward_env,
      containerImage: this.sandboxRunner.name === 'container' ? providerConfig.sandbox?.image : undefined,
      containerCommand: this.sandboxRunner.name === 'container'
        ? (providerConfig.sandbox?.command ?? providerConfig.command)
        : undefined,
      outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
      extraReadOnlyPaths: providerSandboxPlan?.readOnlyPaths,
      extraMounts: providerAuthMounts,
      extraPathEntries: providerSandboxPlan?.pathEntries,
    } : undefined;

    await this.completeProviderJob({
      command,
      topicId: params.topicId,
      topicLineage,
      agentName: params.agentName,
      triggerMessageId: params.triggerMessageId,
      language: params.language,
      userEmail: params.userEmail,
      requesterUserId: params.requesterUserId,
      chainRootBatchId: params.chainRootBatchId,
      chainDepth: params.chainDepth,
      requesterRole: params.requesterRole,
      topicArtifacts,
      executionMode: params.effectiveMode,
      sandboxRunner: needsSandbox ? this.sandboxRunner : undefined,
      sandboxOptions,
      outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
      jobId: params.jobId,
    });
    } catch (error: unknown) {
      this.failJob(params.topicId, params.jobId, params.agentName, `Unexpected orchestrator error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { fs.rmSync(this.getJobOutputRoot(params.jobId), { recursive: true, force: true }); } catch {}
    }
  }

  private async completeProviderJob(params: {
    command: string;
    topicId: number;
    topicLineage: number[];
    agentName: string;
    triggerMessageId: number;
    language: string;
    userEmail: string;
    requesterUserId: string | null;
    chainRootBatchId: number;
    chainDepth: number;
    requesterRole: UserRole;
    topicArtifacts?: ReturnType<typeof listScopedArtifactContext>;
    executionMode: ExecutionMode;
    sandboxRunner?: SandboxRunner;
    sandboxOptions?: SandboxOptions;
    outputDir?: string;
    jobId: number;
    userInputResultsText?: string;
  }): Promise<void> {
    let artifactWriteErrorText: string | undefined;

    for (let repairRound = 0; repairRound <= MAX_ARTIFACT_REPAIR_ROUNDS; repairRound++) {
      const { result, artifactReadAccess, pendingUserInput } = await this.runAgentWithArtifactOps({
        command: params.command,
        topicId: params.topicId,
        topicLineage: params.topicLineage,
        agentName: params.agentName,
        triggerMessageId: params.triggerMessageId,
        language: params.language,
        topicArtifacts: params.topicArtifacts,
        executionMode: params.executionMode,
        sandboxRunner: params.sandboxRunner,
        sandboxOptions: params.sandboxOptions,
        outputDir: params.outputDir,
        jobId: params.jobId,
        artifactWriteErrorText,
        userInputResultsText: params.userInputResultsText,
      });

      if (result.timedOut) {
        this.failJob(
          params.topicId,
          params.jobId,
          params.agentName,
          formatAgentFailure(result),
          { timedOut: true }
        );
        return;
      }

      if (pendingUserInput) {
        if (!params.requesterUserId) {
          this.failJob(params.topicId, params.jobId, params.agentName, 'User input requests require a resolved requester user_id');
          return;
        }
        if (getPendingJobInputRequest(this.db, params.jobId)) {
          this.failJob(params.topicId, params.jobId, params.agentName, 'At most one pending input request is allowed per job');
          return;
        }
        if (result.exitCode !== 0) {
          this.failJob(params.topicId, params.jobId, params.agentName, formatAgentFailure(result));
          return;
        }

        const pausedOutput = resolveAgentOutputAllowEmpty(result, params.outputDir);
        if ('error' in pausedOutput) {
          this.failJob(params.topicId, params.jobId, params.agentName, pausedOutput.error);
          return;
        }

        const waiting = this.pauseJobForUserInput({
          topicId: params.topicId,
          jobId: params.jobId,
          agentName: params.agentName,
          requesterUserId: params.requesterUserId,
          request: pendingUserInput,
          agentOutput: pausedOutput.agentOutput,
        });
        if ('error' in waiting) {
          this.failJob(params.topicId, params.jobId, params.agentName, waiting.error);
          return;
        }

        emitEvent(this.db, 'agent.job.waiting_input', params.topicId, JSON.stringify({
          job_id: params.jobId,
          agent: params.agentName,
          request_id: waiting.request.requestId,
        }));
        this.callbacks.onJobWaitingInput(params.topicId, params.jobId, params.agentName, waiting.request);
        return;
      }

      const resolvedOutput = resolveAgentOutput(result, params.outputDir);
      if ('error' in resolvedOutput) {
        this.failJob(params.topicId, params.jobId, params.agentName, resolvedOutput.error);
        return;
      }

      const preparedArtifacts = params.outputDir
        ? prepareArtifactIngest(this.db, {
            outputDir: params.outputDir,
            topicId: params.topicId,
            jobId: params.jobId,
            agentName: params.agentName,
            userEmail: params.userEmail,
            artifactReadAccess,
            enforceCurrentRead: true,
          })
        : null;

      if (preparedArtifacts && preparedArtifacts.errorDetails.length > 0) {
        const error = preparedArtifacts.errors.join('\n');
        const canRepair =
          repairRound < MAX_ARTIFACT_REPAIR_ROUNDS &&
          isRepairableArtifactWriteError(preparedArtifacts.errorDetails);

        if (canRepair) {
          const attempt = repairRound + 1;
          emitEvent(this.db, 'agent.job.retrying', params.topicId, JSON.stringify({
            job_id: params.jobId,
            agent: params.agentName,
            attempt,
            errors: preparedArtifacts.errors,
          }));
          this.callbacks.onJobRetrying(params.topicId, params.jobId, params.agentName, attempt, error);
          artifactWriteErrorText = formatArtifactWriteErrorBlock(
            attempt,
            resolvedOutput.agentOutput,
            preparedArtifacts.errors
          );
          continue;
        }

        emitEvent(this.db, 'artifact.ingest.error', params.topicId, JSON.stringify({
          job_id: params.jobId,
          agent: params.agentName,
          errors: preparedArtifacts.errors,
        }));
        this.failJob(params.topicId, params.jobId, params.agentName, error);
        return;
      }

      const committed = this.commitSuccessfulJob({
        topicId: params.topicId,
        jobId: params.jobId,
        agentName: params.agentName,
        userEmail: params.userEmail,
        agentOutput: resolvedOutput.agentOutput,
        outputDir: params.outputDir,
        preparedArtifacts,
        artifactReadAccess,
      });

      if ('error' in committed) {
        emitEvent(this.db, 'artifact.ingest.error', params.topicId, JSON.stringify({
          job_id: params.jobId,
          agent: params.agentName,
          errors: [committed.error],
        }));
        this.failJob(params.topicId, params.jobId, params.agentName, committed.error);
        return;
      }

      for (const item of committed.imported) {
        const eventKind =
          item.op === 'create'
            ? 'artifact.created'
            : item.op === 'restore'
              ? 'artifact.restored'
              : 'artifact.updated';
        emitEvent(this.db, eventKind, params.topicId, JSON.stringify({
          artifact_id: item.artifact.id,
          version_id: item.version.id,
          version: item.version.version,
          kind: item.artifact.kind,
          title: item.artifact.title,
          agent: params.agentName,
          job_id: params.jobId,
          message_id: committed.outputMessageId,
        }));
      }

      const ingestSummary = formatIngestSummary(committed.imported);
      if (ingestSummary) {
        this.insertSystemMessage(params.topicId, ingestSummary);
      }

      emitEvent(this.db, 'agent.job.completed', params.topicId, JSON.stringify({ job_id: params.jobId, agent: params.agentName }));
      this.callbacks.onJobCompleted(params.topicId, params.jobId, params.agentName, committed.outputMessageId);

      await this.maybeExecuteChains(
        resolvedOutput.agentOutput,
        committed.outputMessageId,
        params.agentName,
        params.topicId,
        params.userEmail,
        params.chainRootBatchId,
        params.chainDepth,
        params.requesterRole
      );
      return;
    }

    this.failJob(
      params.topicId,
      params.jobId,
      params.agentName,
      `Artifact write auto-repair exceeded max rounds (${MAX_ARTIFACT_REPAIR_ROUNDS})`
    );
  }

  private async runAgentWithArtifactOps(params: {
    command: string;
    topicId: number;
    topicLineage: number[];
    agentName: string;
    triggerMessageId: number;
    language: string;
    topicArtifacts?: ReturnType<typeof listScopedArtifactContext>;
    executionMode: ExecutionMode;
    sandboxRunner?: SandboxRunner;
    sandboxOptions?: SandboxOptions;
    outputDir?: string;
    jobId: number;
    artifactWriteErrorText?: string;
    userInputResultsText?: string;
  }): Promise<{ result: JobResult; artifactReadAccess: ArtifactReadAccessState; pendingUserInput?: ReturnType<typeof validateUserInputRequest>['request'] }> {
    let artifactReadAccess: ArtifactReadAccessState = { currentVersionsRead: {}, versionsRead: {} };
    let artifactOpResultsText: string | undefined;
    const accumulatedArtifactResults: ReturnType<typeof executeArtifactOps>['results'] = [];

    for (let round = 0; round <= MAX_ARTIFACT_OP_ROUNDS; round++) {
      if (params.outputDir) {
        clearJobControlFiles(params.outputDir);
      }

      if (round > 0) {
        const phase = `processing artifact read results (round ${round})`;
        emitEvent(this.db, 'agent.job.round_started', params.topicId, JSON.stringify({
          job_id: params.jobId,
          agent: params.agentName,
          round,
          phase,
        }));
        this.callbacks.onJobRoundStarted(params.topicId, params.jobId, params.agentName, round, phase);
      }

      const context = buildContext(
        this.db,
        params.agentName,
        params.topicId,
        params.triggerMessageId,
        params.language,
        this.config,
        this.basePath,
        params.topicArtifacts,
        artifactOpResultsText,
        params.artifactWriteErrorText,
        params.userInputResultsText
      );

      const result = await runAgent({
        command: params.command,
        context,
        cwd: this.basePath,
        executionMode: params.executionMode,
        sandboxRunner: params.sandboxRunner,
        sandboxOptions: params.sandboxOptions,
        outputDir: params.outputDir,
        timeoutMs: resolveTimeout(params.agentName, this.config),
        killGraceMs: resolveKillGrace(params.agentName, this.config),
        onChunk: (chunk) => {
          this.callbacks.onJobStream(params.topicId, params.jobId, chunk);
        },
        onActivity: (event) => {
          this.callbacks.onJobActivity(params.topicId, params.jobId, params.agentName, event);
        },
      });

      if (result.timedOut) {
        return { result, artifactReadAccess };
      }

      if (!params.outputDir || result.exitCode !== 0) {
        return { result, artifactReadAccess };
      }

      const { raw, error } = readArtifactOpsFile(params.outputDir);
      if (error) {
        return {
          result: {
            output: error,
            exitCode: 1,
            timedOut: false,
            stderr: result.stderr,
          },
          artifactReadAccess,
        };
      }

      if (raw === null) {
        const userInput = readUserInputFile(params.outputDir);
        if (userInput.error) {
          return {
            result: {
              output: userInput.error,
              exitCode: 1,
              timedOut: false,
              stderr: result.stderr,
            },
            artifactReadAccess,
          };
        }

        if (userInput.raw !== null) {
          const validatedRequest = validateUserInputRequest(userInput.raw);
          if (!validatedRequest.request) {
            return {
              result: {
                output: validatedRequest.errors.join('\n'),
                exitCode: 1,
                timedOut: false,
                stderr: result.stderr,
              },
              artifactReadAccess,
            };
          }
          return { result, artifactReadAccess, pendingUserInput: validatedRequest.request };
        }

        return { result, artifactReadAccess };
      }

      if (round === MAX_ARTIFACT_OP_ROUNDS) {
        return {
          result: {
            output: `Artifact read loop exceeded max rounds (${MAX_ARTIFACT_OP_ROUNDS})`,
            exitCode: 1,
            timedOut: false,
            stderr: result.stderr,
          },
          artifactReadAccess,
        };
      }

      const validated = validateArtifactOps(raw);
      if (!validated.ops) {
        const validationError = validated.errors
          .map((e) =>
            e.entry !== undefined
              ? `artifact-ops entry ${e.entry}: ${e.message}`
              : `artifact-ops: ${e.message}`
          )
          .join('\n');
        return {
          result: {
            output: validationError,
            exitCode: 1,
            timedOut: false,
            stderr: result.stderr,
          },
          artifactReadAccess,
        };
      }

      const executed = executeArtifactOps(
        this.db,
        params.topicLineage,
        validated.ops,
        artifactReadAccess
      );
      artifactReadAccess = executed.accessState;
      accumulatedArtifactResults.push(...executed.results);
      artifactOpResultsText = formatArtifactOpResults(accumulatedArtifactResults);
    }

    return {
      result: {
        output: `Artifact read loop exceeded max rounds (${MAX_ARTIFACT_OP_ROUNDS})`,
        exitCode: 1,
        timedOut: false,
      },
      artifactReadAccess,
    };
  }

  private async completeJobFromResult(
    result: JobResult,
    jobId: number,
    agentName: string,
    topicId: number,
    userEmail: string,
    requesterUserId: string | null,
    chainRootBatchId: number,
    chainDepth: number,
    requesterRole: UserRole,
    outputDir?: string,
    _artifactReadAccess?: ArtifactReadAccessState
  ): Promise<void> {
    const resolvedOutput = resolveAgentOutput(result, outputDir);
    if ('error' in resolvedOutput) {
      this.failJob(topicId, jobId, agentName, resolvedOutput.error);
      return;
    }

    const committed = this.commitSuccessfulJob({
      topicId,
      jobId,
      agentName,
      userEmail,
      agentOutput: resolvedOutput.agentOutput,
      outputDir,
      preparedArtifacts: null,
    });

    if ('error' in committed) {
      this.failJob(topicId, jobId, agentName, committed.error);
      return;
    }

    emitEvent(this.db, 'agent.job.completed', topicId, JSON.stringify({ job_id: jobId, agent: agentName }));
    this.callbacks.onJobCompleted(topicId, jobId, agentName, committed.outputMessageId);
    await this.maybeExecuteChains(
      resolvedOutput.agentOutput,
      committed.outputMessageId,
      agentName,
      topicId,
      userEmail,
      chainRootBatchId,
      chainDepth,
      requesterRole
    );
  }

  private commitSuccessfulJob(params: {
    topicId: number;
    jobId: number;
    agentName: string;
    userEmail: string;
    agentOutput: string;
    outputDir?: string;
    preparedArtifacts: PreparedArtifactIngest | null;
    artifactReadAccess?: ArtifactReadAccessState;
  }):
    | {
        outputMessageId: number;
        imported: Array<{ artifact: any; version: any; op: 'create' | 'update' | 'rewrite-from-version' | 'restore' }>;
      }
    | { error: string } {
    try {
      return this.db.transaction(() => {
        const outputMessageId = insertMessage(
          this.db,
          params.topicId,
          'agent',
          params.agentName,
          params.agentOutput
        );

        let imported: Array<{ artifact: any; version: any; op: 'create' | 'update' | 'rewrite-from-version' | 'restore' }> = [];
        if (params.outputDir && params.preparedArtifacts) {
          const ingestResult = commitPreparedArtifactIngest(this.db, {
            outputDir: params.outputDir,
            topicId: params.topicId,
            messageId: outputMessageId,
            jobId: params.jobId,
            agentName: params.agentName,
            userEmail: params.userEmail,
            artifactReadAccess: params.artifactReadAccess,
            enforceCurrentRead: true,
          }, params.preparedArtifacts.preparedDocs);
          if (ingestResult.errors.length > 0) {
            throw new Error(ingestResult.errors.join('\n'));
          }
          imported = ingestResult.imported;
        }

        updateJobStatus(this.db, params.jobId, 'done', {
          output_message_id: outputMessageId,
        });

        return { outputMessageId, imported };
      })();
    } catch (e: any) {
      return { error: e.message };
    }
  }

  private failJob(
    topicId: number,
    jobId: number,
    agentName: string,
    error: string,
    options?: { timedOut?: boolean }
  ): void {
    updateJobStatus(this.db, jobId, 'failed', { error });
    emitEvent(
      this.db,
      'agent.job.failed',
      topicId,
      JSON.stringify({ job_id: jobId, agent: agentName, error, ...(options?.timedOut ? { timed_out: true } : {}) })
    );
    this.callbacks.onJobFailed(topicId, jobId, agentName, error, options);
  }

  private insertSystemMessage(topicId: number, text: string): number {
    const messageId = insertMessage(this.db, topicId, 'system', 'teepee', text);
    this.callbacks.onSystemMessage(topicId, messageId, text);
    return messageId;
  }

  private pauseJobForUserInput(params: {
    topicId: number;
    jobId: number;
    agentName: string;
    requesterUserId: string;
    request: NonNullable<ReturnType<typeof validateUserInputRequest>['request']>;
    agentOutput: string;
  }): { request: JobInputRequestPayload } | { error: string } {
    try {
      return this.db.transaction(() => {
        const outputMessageId = params.agentOutput.trim()
          ? insertMessage(this.db, params.topicId, 'agent', params.agentName, params.agentOutput)
          : null;

        const request = createJobInputRequest(this.db, {
          jobId: params.jobId,
          topicId: params.topicId,
          requestedByAgent: params.agentName,
          requestedByMessageId: outputMessageId,
          requestedByUserId: params.requesterUserId,
          request: params.request,
        });

        markJobWaitingInput(this.db, params.jobId, request.requestId);
        return { request };
      })();
    } catch (error: any) {
      return { error: error.message };
    }
  }

  async resumeJobFromUserInput(
    requestId: number,
    responderUserId: string,
    responsePayload: unknown
  ): Promise<{ topicId: number; jobId: number; agentName: string; requestId: number; answeredByUserId: string }> {
    const request = getJobInputRequestById(this.db, requestId);
    if (!request) throw new Error('Input request not found');
    if (request.status !== 'pending') throw new Error(`Input request is not pending (${request.status})`);
    if (request.requestedByUserId !== responderUserId) throw new Error('Only the user who started the job can answer this request');

    const responseValidation = validateUserInputResponse({
      kind: request.kind,
      required: request.required,
      allowComment: request.allowComment,
      options: request.options,
    }, responsePayload);
    if (!responseValidation.response) {
      throw new Error(responseValidation.errors.join('\n'));
    }

    const jobRow = getJob(this.db, request.jobId) as any;
    if (!jobRow) throw new Error(`Job ${request.jobId} not found`);
    if (jobRow.status !== 'waiting_input') throw new Error(`Job ${request.jobId} is not waiting for input`);

    const resumeInfo = this.db.transaction(() => {
      const answered = answerJobInputRequest(this.db, requestId, responderUserId, responseValidation.response!);
      if (!answered) {
        throw new Error('Input request is no longer pending');
      }

      markJobResumed(this.db, request.jobId);

      const responder = getUserByIdOrThrow(this.db, responderUserId);
      const summary = formatDecisionSummary(request.title, responseValidation.response!, responder.handle ?? responder.email);
      const decisionMessageId = this.insertSystemMessage(request.topicId, summary);
      return { decisionMessageId };
    })();

    const answeredRequest = getJobInputRequestById(this.db, requestId);
    if (!answeredRequest || !answeredRequest.response || !answeredRequest.answeredByUserId) {
      throw new Error(`Input request ${requestId} was answered but could not be reloaded`);
    }

    const runInfo = this.db.prepare(
      `SELECT
         j.id as job_id,
         j.agent_name,
         j.requested_by_email,
         j.requested_by_user_id,
         j.effective_mode,
         j.effective_profile,
         b.id as batch_id,
         b.trigger_message_id,
         COALESCE(b.chain_root_batch_id, b.id) as chain_root_batch_id,
         b.chain_depth,
         t.id as topic_id,
         t.language
       FROM jobs j
       JOIN invocation_batches b ON b.id = j.batch_id
       JOIN messages m ON m.id = b.trigger_message_id
       JOIN topics t ON t.id = m.topic_id
       WHERE j.id = ?`
    ).get(request.jobId) as any;

    if (!runInfo) throw new Error(`Job ${request.jobId} resume context not found`);

    this.callbacks.onRuntimeChanged?.(runInfo.topic_id);

    const jobPromise = this.runResumedJob({
      jobId: runInfo.job_id,
      agentName: runInfo.agent_name,
      topicId: runInfo.topic_id,
      triggerMessageId: resumeInfo.decisionMessageId,
      language: runInfo.language ?? this.config.teepee.language,
      userEmail: runInfo.requested_by_email ?? getUserByIdOrThrow(this.db, runInfo.requested_by_user_id).email,
      requesterUserId: runInfo.requested_by_user_id,
      chainRootBatchId: runInfo.chain_root_batch_id,
      chainDepth: runInfo.chain_depth,
      requesterRole: this.resolveUserRole(runInfo.requested_by_email ?? getUserByIdOrThrow(this.db, runInfo.requested_by_user_id).email),
      effectiveMode: (runInfo.effective_mode ?? 'disabled') as ExecutionMode,
      effectiveProfile: runInfo.effective_profile as AgentAccessProfile | null,
      userInputResultsText: formatUserInputResults(answeredRequest),
      requestId,
      answeredByUserId: answeredRequest.answeredByUserId,
    }).finally(() => {
      this.runningJobs.delete(runInfo.job_id);
      this.callbacks.onRuntimeChanged?.(runInfo.topic_id);
      void this.drainScheduler();
    });

    this.runningJobs.set(runInfo.job_id, jobPromise);
    await jobPromise;

    return {
      topicId: runInfo.topic_id,
      jobId: runInfo.job_id,
      agentName: runInfo.agent_name,
      requestId,
      answeredByUserId: answeredRequest.answeredByUserId,
    };
  }

  async cancelJobFromUserInput(
    requestId: number,
    actorUserId: string,
    actorRole: UserRole
  ): Promise<{ topicId: number; jobId: number }> {
    const request = getJobInputRequestById(this.db, requestId);
    if (!request) throw new Error('Input request not found');
    if (request.status !== 'pending') throw new Error(`Input request is not pending (${request.status})`);
    const canCancelAny = hasCapability(this.config, actorRole, 'input_requests.cancel.any');
    if (request.requestedByUserId !== actorUserId && !canCancelAny) {
      throw new Error('Only the requester or an authorized admin can cancel this request');
    }

    this.db.transaction(() => {
      const cancelled = cancelJobInputRequest(this.db, requestId);
      if (!cancelled) throw new Error('Input request is no longer pending');
      cancelJob(this.db, request.jobId, 'User input request cancelled');
      this.insertSystemMessage(request.topicId, `Richiesta annullata: ${request.title}`);
    })();

    this.callbacks.onRuntimeChanged?.(request.topicId);
    await this.drainScheduler();

    return { topicId: request.topicId, jobId: request.jobId };
  }

  private async runResumedJob(params: {
    jobId: number;
    agentName: string;
    topicId: number;
    triggerMessageId: number;
    language: string;
    userEmail: string;
    requesterUserId: string | null;
    chainRootBatchId: number;
    chainDepth: number;
    requesterRole: UserRole;
    effectiveMode: ExecutionMode;
    effectiveProfile: AgentAccessProfile | null;
    userInputResultsText: string;
    requestId: number;
    answeredByUserId: string;
  }): Promise<void> {
    const agentConfig = this.config.agents[params.agentName];
    const providerConfig = this.config.providers[agentConfig.provider];
    const policy = resolveExecutionPolicy(params.effectiveProfile);

    // Fail-closed preflight — identical checks on initial start and resume
    const preflightError = validateJobRunPreconditions({
      agentName: params.agentName,
      providerName: agentConfig.provider,
      effectiveMode: params.effectiveMode,
      policyReason: policy.reason,
      sandboxAvailable: this.sandboxAvailable,
      sandboxRunnerName: this.sandboxRunner.name,
      providerSandboxImage: providerConfig.sandbox?.image,
    });
    if (preflightError) {
      updateJobStatus(this.db, params.jobId, 'failed', { error: preflightError, requested_by_email: params.userEmail, requested_by_user_id: params.requesterUserId ?? undefined, effective_mode: params.effectiveMode, effective_profile: params.effectiveProfile });
      emitEvent(this.db, 'agent.job.failed', params.topicId, JSON.stringify({ job_id: params.jobId, agent: params.agentName, error: preflightError, requested_by: params.userEmail, requester_role: params.requesterRole, effective_mode: params.effectiveMode, effective_profile: params.effectiveProfile }));
      this.callbacks.onJobFailed(params.topicId, params.jobId, params.agentName, preflightError);
      return;
    }

    const jobOutputDir = this.getJobOutputDir(params.jobId);
    fs.mkdirSync(path.join(jobOutputDir, 'files'), { recursive: true });

    try {
      emitEvent(this.db, 'agent.job.resumed', params.topicId, JSON.stringify({
        job_id: params.jobId,
        agent: params.agentName,
        request_id: params.requestId,
        answered_by_user_id: params.answeredByUserId,
      }));
      this.callbacks.onJobResumed(params.topicId, params.jobId, params.agentName, params.requestId, params.answeredByUserId);

      const topicLineage = getTopicLineage(this.db, params.topicId);
      const topicArtifacts = policy.canWriteArtifacts
        ? listScopedArtifactContext(this.db, topicLineage)
        : undefined;
      const needsSandbox = params.effectiveMode === 'sandbox';
      const providerSandboxPlan = needsSandbox && this.sandboxRunner.name === 'bubblewrap'
        ? buildSandboxCommandMountPlan(providerConfig.command)
        : null;
      const providerAuthMounts = needsSandbox && this.sandboxRunner.name === 'bubblewrap'
        ? buildSandboxAuthMountPlan(providerConfig.command)
        : [];
      const sandboxOptions = needsSandbox ? {
        projectRoot: this.basePath,
        readOnlyProject: policy.sandboxReadOnly,
        emptyHome: this.config.security.sandbox.empty_home,
        privateTmp: this.config.security.sandbox.private_tmp,
        forwardEnv: this.config.security.sandbox.forward_env,
        containerImage: this.sandboxRunner.name === 'container' ? providerConfig.sandbox?.image : undefined,
        containerCommand: this.sandboxRunner.name === 'container'
          ? (providerConfig.sandbox?.command ?? providerConfig.command)
          : undefined,
        outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
        extraReadOnlyPaths: providerSandboxPlan?.readOnlyPaths,
        extraMounts: providerAuthMounts,
        extraPathEntries: providerSandboxPlan?.pathEntries,
      } : undefined;

      await this.completeProviderJob({
        command: providerConfig.command,
        topicId: params.topicId,
        topicLineage,
        agentName: params.agentName,
        triggerMessageId: params.triggerMessageId,
        language: params.language,
        userEmail: params.userEmail,
        requesterUserId: params.requesterUserId,
        chainRootBatchId: params.chainRootBatchId,
        chainDepth: params.chainDepth,
        requesterRole: params.requesterRole,
        topicArtifacts,
        executionMode: params.effectiveMode,
        sandboxRunner: needsSandbox ? this.sandboxRunner : undefined,
        sandboxOptions,
        outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
        jobId: params.jobId,
        userInputResultsText: params.userInputResultsText,
      });
    } catch (error: unknown) {
      this.failJob(params.topicId, params.jobId, params.agentName, `Unexpected resumed-job error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { fs.rmSync(this.getJobOutputRoot(params.jobId), { recursive: true, force: true }); } catch {}
    }
  }

  private async maybeExecuteChains(
    agentOutput: string,
    outputMessageId: number,
    agentName: string,
    topicId: number,
    userEmail: string,
    chainRootBatchId: number,
    chainDepth: number,
    requesterRole: UserRole
  ): Promise<void> {
    if (chainDepth >= this.config.limits.max_chain_depth) {
      return;
    }

    const agentConfig = this.config.agents[agentName];
    const sourceChainPolicy = agentName === 'architect'
      ? (agentConfig.chain_policy ?? 'delegate_with_origin_policy')
      : (agentConfig.chain_policy ?? 'none');

    const { active } = parseMentions(agentOutput);
    const resolved = resolveAliases(this.db, topicId, active, this.knownAgents);
    const candidateAgents = resolved.filter(
      (a) => this.knownAgents.has(a) && a !== agentName
    );

    if (candidateAgents.length === 0) {
      return;
    }

    if (sourceChainPolicy === 'none' || sourceChainPolicy === 'propose_only') {
      for (const agent of candidateAgents) {
        insertMention(this.db, outputMessageId, agent, false);
      }
      return;
    }

    if (sourceChainPolicy !== 'delegate_with_origin_policy') {
      return;
    }

    const { allowed, denied } = filterAllowedAgents(
      this.db, userEmail, candidateAgents, topicId, this.config.limits, this.config
    );

    for (const agent of candidateAgents) {
      insertMention(this.db, outputMessageId, agent, allowed.includes(agent));
    }

    if (denied.length > 0) {
      this.insertSystemMessage(
        topicId,
        `Chain delegation denied for: ${denied.map((a) => '@' + a).join(', ')}`
      );
    }

    if (allowed.length > 0) {
      await this.enqueueBatch(
        topicId,
        outputMessageId,
        allowed,
        userEmail,
        chainRootBatchId,
        chainDepth + 1,
        requesterRole,
        candidateAgents.length > 1
      );
    }
  }
}

function resolveAgentOutput(
  result: JobResult,
  outputDir?: string
): { agentOutput: string } | { error: string } {
  if (result.exitCode !== 0 || !result.output) {
    let fallbackOutput: string | undefined;
    if (outputDir) {
      const responsePath = path.join(outputDir, 'response.md');
      try {
        if (fs.existsSync(responsePath)) {
          fallbackOutput = fs.readFileSync(responsePath, 'utf-8').trim();
        }
      } catch {}
    }
    if (!fallbackOutput) {
      return { error: formatAgentFailure(result) };
    }
    result = { ...result, output: fallbackOutput, exitCode: 0 };
  }

  let agentOutput = result.output;
  if (outputDir) {
    const responsePath = path.join(outputDir, 'response.md');
    try {
      if (fs.existsSync(responsePath)) {
        const responseContent = fs.readFileSync(responsePath, 'utf-8').trim();
        if (responseContent) {
          agentOutput = responseContent;
        }
      }
    } catch {}
  }

  return { agentOutput };
}

function resolveAgentOutputAllowEmpty(
  result: JobResult,
  outputDir?: string
): { agentOutput: string } | { error: string } {
  if (result.exitCode !== 0) {
    return { error: formatAgentFailure(result) };
  }

  let agentOutput = result.output ?? '';
  if (outputDir) {
    const responsePath = path.join(outputDir, 'response.md');
    try {
      if (fs.existsSync(responsePath)) {
        agentOutput = fs.readFileSync(responsePath, 'utf-8').trim();
      }
    } catch {}
  }

  return { agentOutput: agentOutput.trim() };
}

function isRepairableArtifactWriteError(errors: IngestErrorDetail[]): boolean {
  return errors.length > 0 && errors.every((error) => error.recoverable);
}

function formatArtifactWriteErrorBlock(
  attempt: number,
  previousOutput: string,
  errors: string[]
): string {
  const lines = [
    `attempt=${attempt}`,
    'The previous artifact write failed during validation or preflight.',
    'Retry is exceptional: correct only the artifact write issue, or omit artifact output if it is unnecessary.',
    '',
    'previous_response:',
    previousOutput,
    '',
    'errors:',
    ...errors.map((error) => `- ${error}`),
  ];
  return lines.join('\n');
}

function formatDecisionSummary(
  title: string,
  response: { value: boolean | string | string[]; comment?: string },
  responderName: string
): string {
  const value = Array.isArray(response.value)
    ? response.value.join(', ')
    : String(response.value);
  const comment = response.comment ? `\nCommento: ${response.comment}` : '';
  return `Decisione registrata da ${responderName}: ${title}\nValore: ${value}${comment}`;
}

function getUserByIdOrThrow(db: DatabaseType, userId: string) {
  const user = getUserById(db, userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }
  return user;
}

function runDbOnlyAgent(command: string): JobResult {
  const prefix = 'teepee:static';
  if (command !== prefix && !command.startsWith(`${prefix} `)) {
    return {
      output: 'Blocked: db_only agents cannot execute external provider commands',
      exitCode: 1,
      timedOut: false,
    };
  }

  const output = command.slice(prefix.length).trim();
  return { output, exitCode: output ? 0 : 1, timedOut: false };
}

function formatAgentFailure(result: JobResult): string {
  if (result.timedOut) {
    return result.error || 'Agent idle timeout';
  }
  if (result.error) {
    return `Agent process failed to start: ${result.error}`;
  }

  if (result.signal) {
    return result.stderr
      ? `Agent process exited from signal ${result.signal}:\n${result.stderr}`
      : `Agent process exited from signal ${result.signal}`;
  }

  if (result.exitCode === 0 && !result.output) {
    return result.stderr
      ? `Agent exited successfully but produced no output.\n${result.stderr}`
      : 'Agent exited successfully but produced no output.';
  }

  const details = [result.output, result.stderr].filter(Boolean).join('\n');
  return details
    ? `Agent exited with code ${result.exitCode}:\n${details}`
    : `Agent exited with code ${result.exitCode}`;
}

function clearJobControlFiles(outputDir: string): void {
  for (const filename of ['artifact-ops.json', 'artifacts.json', 'response.md', 'user-input.json']) {
    try {
      fs.rmSync(path.join(outputDir, filename), { force: true });
    } catch {
      // Ignore cleanup failures; later read/ingest steps will surface real issues.
    }
  }
}

function isWriteProfile(profile: AgentAccessProfile | null | undefined): boolean {
  return profile === 'readwrite' || profile === 'trusted';
}
