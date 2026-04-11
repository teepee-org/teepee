import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { TeepeeConfig, ExecutionMode, AgentAccessProfile } from './config.js';
import { resolveRoleAgentProfile } from './config.js';
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
import { listTopicArtifactContext } from './db/artifacts.js';
import { parseMentions, resolveAliases } from './mentions.js';
import { filterAllowedAgents } from './permissions.js';
import { buildContext, runAgent, type JobResult } from './executor.js';
import { resolveExecutionPolicy, validateSandboxAvailability } from './execution-policy.js';
import {
  commitPreparedArtifactIngest,
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
import type { UserRole } from './commands/types.js';
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
  onJobWaitingInput(topicId: number, jobId: number, agentName: string, request: JobInputRequestPayload): void;
  onJobResumed(topicId: number, jobId: number, agentName: string, requestId: number, answeredByUserId: string): void;
  onJobCompleted(topicId: number, jobId: number, agentName: string, messageId: number): void;
  onJobFailed(topicId: number, jobId: number, agentName: string, error: string): void;
  onSystemMessage(topicId: number, text: string): void;
}

const MAX_ARTIFACT_REPAIR_ROUNDS = 1;

export class Orchestrator {
  private db: DatabaseType;
  private config: TeepeeConfig;
  private basePath: string;
  private callbacks: OrchestratorCallbacks;
  private knownAgents: Set<string>;
  private sandboxRunner: SandboxRunner;
  private sandboxAvailable: boolean;
  private sandboxBackend: string;
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
    const requesterUserId = getUser(this.db, userEmail)?.id ?? null;

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
        requesterUserId,
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
    return 'collaborator';
  }

  private async executeJob(
    jobId: number,
    agentName: string,
    topicId: number,
    triggerMessageId: number,
    language: string,
    userEmail: string,
    requesterUserId: string | null,
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
      requesterUserId,
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
    requesterUserId: string | null,
    chainRootBatchId: number,
    chainDepth: number,
    requesterRole: UserRole
  ): Promise<void> {
    // Resolve execution policy
    const agentConfig = this.config.agents[agentName];
    const providerConfig = this.config.providers[agentConfig.provider];
    const agentProfile = resolveRoleAgentProfile(this.config, requesterRole, agentName);
    const policy = resolveExecutionPolicy(agentProfile);

    // Record execution metadata
    const effectiveMode: ExecutionMode = policy.mode;
    const effectiveProfile: AgentAccessProfile | null = agentProfile;

    // Block disabled agents — persist audit metadata even on denial
    if (effectiveMode === 'disabled') {
      const error = `Agent '${agentName}' is disabled: ${policy.reason}`;
      updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, requested_by_user_id: requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
      emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, requester_role: requesterRole, effective_mode: effectiveMode, effective_profile: effectiveProfile }));
      this.callbacks.onJobFailed(topicId, jobId, agentName, error);
      return;
    }

    // Validate sandbox availability when required — persist audit metadata on fail-closed
    if (effectiveMode === 'sandbox') {
      const sandboxError = validateSandboxAvailability(effectiveMode, this.sandboxAvailable);
      if (sandboxError) {
        const error = sandboxError;
        updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, requested_by_user_id: requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
        emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, requester_role: requesterRole, effective_mode: effectiveMode, effective_profile: effectiveProfile }));
        this.callbacks.onJobFailed(topicId, jobId, agentName, error);
        return;
      }

      if (this.sandboxRunner.name === 'container' && !providerConfig.sandbox?.image) {
        const error = `Sandbox backend 'container' requires provider '${agentConfig.provider}' to define providers.${agentConfig.provider}.sandbox.image`;
        updateJobStatus(this.db, jobId, 'failed', { error, requested_by_email: userEmail, requested_by_user_id: requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
        emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error, requested_by: userEmail, requester_role: requesterRole, effective_mode: effectiveMode, effective_profile: effectiveProfile }));
        this.callbacks.onJobFailed(topicId, jobId, agentName, error);
        return;
      }
    }

    // Create per-job output directory
    const jobOutputDir = path.join(os.tmpdir(), 'teepee', 'jobs', String(jobId), 'out');
    fs.mkdirSync(path.join(jobOutputDir, 'files'), { recursive: true });

    try {
    // Start
    updateJobStatus(this.db, jobId, 'running', { requested_by_email: userEmail, requested_by_user_id: requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
    emitEvent(this.db, 'agent.job.started', topicId, JSON.stringify({
      job_id: jobId, agent: agentName, requested_by: userEmail, requester_role: requesterRole, effective_mode: effectiveMode, effective_profile: effectiveProfile,
      sandbox_backend: effectiveMode === 'sandbox' ? this.sandboxBackend : undefined,
    }));
    this.callbacks.onJobStarted(topicId, jobId, agentName);
    logUsage(this.db, userEmail, agentName, jobId);

    const command = providerConfig.command;
    if (effectiveMode === 'db_only') {
      const result = runDbOnlyAgent(providerConfig.command);
      await this.completeJobFromResult(
        result,
        jobId,
        agentName,
        topicId,
        userEmail,
        requesterUserId,
        chainRootBatchId,
        chainDepth,
        requesterRole,
        policy.canWriteArtifacts ? jobOutputDir : undefined
      );
      return;
    }

    const topicArtifacts = policy.canWriteArtifacts
      ? listTopicArtifactContext(this.db, topicId)
      : undefined;

    const needsSandbox = effectiveMode === 'sandbox';
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
    } : undefined;

    await this.completeProviderJob({
      command,
      topicId,
      agentName,
      triggerMessageId,
      language,
      userEmail,
      requesterUserId,
      chainRootBatchId,
      chainDepth,
      requesterRole,
      topicArtifacts,
      executionMode: effectiveMode,
      sandboxRunner: needsSandbox ? this.sandboxRunner : undefined,
      sandboxOptions,
      outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
      jobId,
    });
    } finally {
      try { fs.rmSync(path.join(os.tmpdir(), 'teepee', 'jobs', String(jobId)), { recursive: true, force: true }); } catch {}
    }
  }

  private async completeProviderJob(params: {
    command: string;
    topicId: number;
    agentName: string;
    triggerMessageId: number;
    language: string;
    userEmail: string;
    requesterUserId: string | null;
    chainRootBatchId: number;
    chainDepth: number;
    requesterRole: UserRole;
    topicArtifacts?: ReturnType<typeof listTopicArtifactContext>;
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
    agentName: string;
    triggerMessageId: number;
    language: string;
    topicArtifacts?: ReturnType<typeof listTopicArtifactContext>;
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
        onChunk: (chunk) => {
          this.callbacks.onJobStream(params.topicId, params.jobId, chunk);
        },
      });

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
        params.topicId,
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

  private failJob(topicId: number, jobId: number, agentName: string, error: string): void {
    updateJobStatus(this.db, jobId, 'failed', { error });
    emitEvent(this.db, 'agent.job.failed', topicId, JSON.stringify({ job_id: jobId, agent: agentName, error }));
    this.callbacks.onJobFailed(topicId, jobId, agentName, error);
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
      const decisionMessageId = insertMessage(this.db, request.topicId, 'system', 'teepee', summary);
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

    const key = `${runInfo.agent_name}:${runInfo.topic_id}`;
    const prev = this.activeJobs.get(key);
    if (prev) await prev;

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
      userInputResultsText: formatUserInputResults(answeredRequest),
      requestId,
      answeredByUserId: answeredRequest.answeredByUserId,
    });
    this.activeJobs.set(key, jobPromise);

    try {
      await jobPromise;
    } finally {
      if (this.activeJobs.get(key) === jobPromise) {
        this.activeJobs.delete(key);
      }
    }

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
    if (request.requestedByUserId !== actorUserId && actorRole !== 'owner') {
      throw new Error('Only the requester or an owner can cancel this request');
    }

    this.db.transaction(() => {
      const cancelled = cancelJobInputRequest(this.db, requestId);
      if (!cancelled) throw new Error('Input request is no longer pending');
      cancelJob(this.db, request.jobId, 'User input request cancelled');
      insertMessage(this.db, request.topicId, 'system', 'teepee', `Richiesta annullata: ${request.title}`);
    })();

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
    userInputResultsText: string;
    requestId: number;
    answeredByUserId: string;
  }): Promise<void> {
    const agentConfig = this.config.agents[params.agentName];
    const providerConfig = this.config.providers[agentConfig.provider];
    const agentProfile = resolveRoleAgentProfile(this.config, params.requesterRole, params.agentName);
    const policy = resolveExecutionPolicy(agentProfile);
    const effectiveMode: ExecutionMode = policy.mode;
    const effectiveProfile: AgentAccessProfile | null = agentProfile;

    if (effectiveMode === 'disabled') {
      const error = `Agent '${params.agentName}' is disabled: ${policy.reason}`;
      updateJobStatus(this.db, params.jobId, 'failed', { error, requested_by_email: params.userEmail, requested_by_user_id: params.requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
      emitEvent(this.db, 'agent.job.failed', params.topicId, JSON.stringify({ job_id: params.jobId, agent: params.agentName, error }));
      this.callbacks.onJobFailed(params.topicId, params.jobId, params.agentName, error);
      return;
    }

    if (effectiveMode === 'sandbox') {
      const sandboxError = validateSandboxAvailability(effectiveMode, this.sandboxAvailable);
      if (sandboxError) {
        updateJobStatus(this.db, params.jobId, 'failed', { error: sandboxError, requested_by_email: params.userEmail, requested_by_user_id: params.requesterUserId ?? undefined, effective_mode: effectiveMode, effective_profile: effectiveProfile });
        emitEvent(this.db, 'agent.job.failed', params.topicId, JSON.stringify({ job_id: params.jobId, agent: params.agentName, error: sandboxError }));
        this.callbacks.onJobFailed(params.topicId, params.jobId, params.agentName, sandboxError);
        return;
      }
    }

    const jobOutputDir = path.join(os.tmpdir(), 'teepee', 'jobs', String(params.jobId), 'out');
    fs.mkdirSync(path.join(jobOutputDir, 'files'), { recursive: true });

    try {
      emitEvent(this.db, 'agent.job.resumed', params.topicId, JSON.stringify({
        job_id: params.jobId,
        agent: params.agentName,
        request_id: params.requestId,
        answered_by_user_id: params.answeredByUserId,
      }));
      this.callbacks.onJobResumed(params.topicId, params.jobId, params.agentName, params.requestId, params.answeredByUserId);

      const topicArtifacts = policy.canWriteArtifacts
        ? listTopicArtifactContext(this.db, params.topicId)
        : undefined;
      const needsSandbox = effectiveMode === 'sandbox';
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
      } : undefined;

      await this.completeProviderJob({
        command: providerConfig.command,
        topicId: params.topicId,
        agentName: params.agentName,
        triggerMessageId: params.triggerMessageId,
        language: params.language,
        userEmail: params.userEmail,
        requesterUserId: params.requesterUserId,
        chainRootBatchId: params.chainRootBatchId,
        chainDepth: params.chainDepth,
        requesterRole: params.requesterRole,
        topicArtifacts,
        executionMode: effectiveMode,
        sandboxRunner: needsSandbox ? this.sandboxRunner : undefined,
        sandboxOptions,
        outputDir: policy.canWriteArtifacts ? jobOutputDir : undefined,
        jobId: params.jobId,
        userInputResultsText: params.userInputResultsText,
      });
    } finally {
      try { fs.rmSync(path.join(os.tmpdir(), 'teepee', 'jobs', String(params.jobId)), { recursive: true, force: true }); } catch {}
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
      const sysMsg = `Chain delegation denied for: ${denied.map((a) => '@' + a).join(', ')}`;
      insertMessage(this.db, topicId, 'system', 'teepee', sysMsg);
      this.callbacks.onSystemMessage(topicId, sysMsg);
    }

    if (allowed.length > 0) {
      await this.executeBatch(
        topicId,
        outputMessageId,
        allowed,
        userEmail,
        chainRootBatchId,
        chainDepth + 1,
        requesterRole
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
