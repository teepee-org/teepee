import type { Database as DatabaseType } from 'better-sqlite3';
import {
  readManifestFile,
  validateManifest,
  readArtifactFile,
  type ArtifactManifest,
  type ManifestBaseVersion,
  type ManifestValidationError,
} from './manifest.js';
import {
  createDocumentArtifact,
  updateDocumentArtifact,
  restoreDocumentArtifact,
  rewriteDocumentArtifactFromVersion,
  linkMessageArtifact,
  ArtifactConflictError,
  getArtifact,
  getCurrentArtifactVersion,
  getArtifactVersionByNumber,
  type ArtifactRow,
  type ArtifactVersionRow,
} from '../db/artifacts.js';
import type { ArtifactReadAccessState } from './ops.js';

export type IngestErrorCode =
  | 'manifest_parse'
  | 'manifest_validation'
  | 'artifact_file'
  | 'artifact_precondition'
  | 'artifact_conflict'
  | 'artifact_import';

export interface IngestErrorDetail {
  code: IngestErrorCode;
  message: string;
  recoverable: boolean;
}

export interface PreparedArtifactDoc {
  doc: ArtifactManifest['documents'][number];
  body?: string;
}

export interface PreparedArtifactIngest {
  manifest: ArtifactManifest | null;
  preparedDocs: PreparedArtifactDoc[];
  errors: string[];
  errorDetails: IngestErrorDetail[];
  skipped: boolean;
}

export interface IngestResult {
  imported: Array<{ artifact: ArtifactRow; version: ArtifactVersionRow; op: 'create' | 'update' | 'rewrite-from-version' | 'restore' }>;
  errors: string[];
  errorDetails: IngestErrorDetail[];
  skipped: boolean;
}

export interface IngestOptions {
  outputDir: string;
  topicId: number;
  messageId?: number;
  jobId: number;
  agentName: string;
  userEmail?: string;
  artifactReadAccess?: ArtifactReadAccessState;
  enforceCurrentRead?: boolean;
}

export function prepareArtifactIngest(
  db: DatabaseType,
  opts: IngestOptions
): PreparedArtifactIngest {
  const result: PreparedArtifactIngest = {
    manifest: null,
    preparedDocs: [],
    errors: [],
    errorDetails: [],
    skipped: false,
  };

  const { raw, error: readError } = readManifestFile(opts.outputDir);
  if (readError) {
    pushIngestError(result, {
      code: 'manifest_parse',
      message: readError,
      recoverable: true,
    });
    result.skipped = true;
    return result;
  }

  if (raw === null) {
    result.skipped = true;
    return result;
  }

  const { manifest, errors: validationErrors } = validateManifest(raw, opts.outputDir);
  if (!manifest) {
    for (const validationError of validationErrors) {
      pushIngestError(result, {
        code: 'manifest_validation',
        message: formatValidationError(validationError),
        recoverable: true,
      });
    }
    result.skipped = true;
    return result;
  }

  result.manifest = manifest;

  const preparedDocs: PreparedArtifactDoc[] = [];
  for (const doc of manifest.documents) {
    if (doc.op === 'restore') {
      preparedDocs.push({ doc });
      continue;
    }

    const { body, error: fileError } = readArtifactFile(opts.outputDir, doc.path);
    if (fileError) {
      pushIngestError(result, {
        code: 'artifact_file',
        message: fileError,
        recoverable: true,
      });
      continue;
    }
    preparedDocs.push({ doc, body });
  }

  if (result.errorDetails.length > 0) {
    result.skipped = true;
    return result;
  }

  for (const preparedDoc of preparedDocs) {
    const validationError = validatePreparedDoc(db, opts, preparedDoc);
    if (validationError) {
      pushIngestError(result, validationError);
    }
  }

  result.preparedDocs = preparedDocs;
  if (result.errorDetails.length > 0) {
    result.skipped = true;
  }

  return result;
}

export function commitPreparedArtifactIngest(
  db: DatabaseType,
  opts: IngestOptions,
  preparedDocs: PreparedArtifactDoc[]
): IngestResult {
  const result: IngestResult = { imported: [], errors: [], errorDetails: [], skipped: false };

  if (preparedDocs.length === 0) {
    return result;
  }

  if (opts.messageId === undefined) {
    throw new Error('commitPreparedArtifactIngest requires messageId');
  }
  const messageId = opts.messageId;

  try {
    const imported = db.transaction(() => {
      const rows: IngestResult['imported'] = [];

      for (const { doc, body } of preparedDocs) {
        if (doc.op === 'create') {
          const { artifact, version } = createDocumentArtifact(db, {
            topicId: opts.topicId,
            kind: doc.kind,
            title: doc.title,
            body: body!,
            createdByAgent: opts.agentName,
            createdByUserEmail: opts.userEmail,
            createdByJobId: opts.jobId,
            createdFromMessageId: messageId,
          });
          linkMessageArtifact(db, messageId, artifact.id, version.id, 'created');
          rows.push({ artifact, version, op: 'create' });
        } else if (doc.op === 'update') {
          const resolvedBaseVersion = resolveBaseVersion(opts, doc.artifact_id, doc.base_version);
          if ('error' in resolvedBaseVersion) {
            throw new Error(resolvedBaseVersion.error);
          }
          const { artifact, version } = updateDocumentArtifact(db, {
            artifactId: doc.artifact_id,
            expectedTopicId: opts.topicId,
            baseVersion: resolvedBaseVersion.value,
            body: body!,
            createdByAgent: opts.agentName,
            createdByUserEmail: opts.userEmail,
            createdByJobId: opts.jobId,
            sourceMessageId: messageId,
          });
          linkMessageArtifact(db, messageId, artifact.id, version.id, 'updated');
          rows.push({ artifact, version, op: 'update' });
        } else if (doc.op === 'rewrite-from-version') {
          const resolvedBaseVersion = resolveBaseVersion(opts, doc.artifact_id, doc.base_version);
          if ('error' in resolvedBaseVersion) {
            throw new Error(resolvedBaseVersion.error);
          }
          const sourceAccessError = validateVersionWasRead(opts, doc.artifact_id, doc.source_version);
          if (sourceAccessError) {
            throw new Error(sourceAccessError);
          }
          const { artifact, version } = rewriteDocumentArtifactFromVersion(db, {
            artifactId: doc.artifact_id,
            expectedTopicId: opts.topicId,
            baseVersion: resolvedBaseVersion.value,
            sourceVersion: doc.source_version,
            body: body!,
            createdByAgent: opts.agentName,
            createdByUserEmail: opts.userEmail,
            createdByJobId: opts.jobId,
            sourceMessageId: messageId,
          });
          linkMessageArtifact(db, messageId, artifact.id, version.id, 'rewritten');
          rows.push({ artifact, version, op: 'rewrite-from-version' });
        } else {
          const resolvedBaseVersion = resolveBaseVersion(opts, doc.artifact_id, doc.base_version);
          if ('error' in resolvedBaseVersion) {
            throw new Error(resolvedBaseVersion.error);
          }
          const { artifact, version } = restoreDocumentArtifact(db, {
            artifactId: doc.artifact_id,
            expectedTopicId: opts.topicId,
            baseVersion: resolvedBaseVersion.value,
            restoreVersion: doc.restore_version,
            createdByAgent: opts.agentName,
            createdByUserEmail: opts.userEmail,
            createdByJobId: opts.jobId,
            sourceMessageId: messageId,
          });
          linkMessageArtifact(db, messageId, artifact.id, version.id, 'restored');
          rows.push({ artifact, version, op: 'restore' });
        }
      }

      return rows;
    })();

    result.imported.push(...imported);
  } catch (e: any) {
    result.skipped = true;
    pushIngestError(result, classifyCommitError(e));
  }

  return result;
}

export function ingestArtifacts(
  db: DatabaseType,
  opts: IngestOptions
): IngestResult {
  const prepared = prepareArtifactIngest(db, opts);
  if (prepared.skipped || prepared.errorDetails.length > 0) {
    return {
      imported: [],
      errors: [...prepared.errors],
      errorDetails: [...prepared.errorDetails],
      skipped: true,
    };
  }

  return commitPreparedArtifactIngest(db, opts, prepared.preparedDocs);
}

function formatValidationError(e: ManifestValidationError): string {
  return e.entry !== undefined
    ? `Manifest entry ${e.entry}: ${e.message}`
    : `Manifest: ${e.message}`;
}

function pushIngestError(
  target: { errors: string[]; errorDetails: IngestErrorDetail[] },
  detail: IngestErrorDetail
): void {
  target.errors.push(detail.message);
  target.errorDetails.push(detail);
}

function validatePreparedDoc(
  db: DatabaseType,
  opts: IngestOptions,
  preparedDoc: PreparedArtifactDoc
): IngestErrorDetail | null {
  const { doc } = preparedDoc;
  if (doc.op === 'create') {
    return null;
  }

  const artifact = getArtifact(db, doc.artifact_id);
  if (!artifact) {
    return {
      code: 'artifact_precondition',
      message: `Failed to import artifacts: Artifact ${doc.artifact_id} not found`,
      recoverable: true,
    };
  }

  if (artifact.topic_id !== opts.topicId) {
    return {
      code: 'artifact_precondition',
      message: `Failed to import artifacts: Artifact ${doc.artifact_id} does not belong to topic ${opts.topicId}`,
      recoverable: true,
    };
  }

  const resolvedBaseVersion = resolveBaseVersion(opts, doc.artifact_id, doc.base_version);
  if ('error' in resolvedBaseVersion) {
    return {
      code: 'artifact_precondition',
      message: `Failed to import artifacts: ${resolvedBaseVersion.error}`,
      recoverable: true,
    };
  }

  const currentVersion = getCurrentArtifactVersion(db, doc.artifact_id);
  const currentVersionNum = currentVersion?.version ?? 0;
  if (resolvedBaseVersion.value !== currentVersionNum) {
    return {
      code: 'artifact_conflict',
      message: new ArtifactConflictError(doc.artifact_id, resolvedBaseVersion.value, currentVersionNum).message,
      recoverable: false,
    };
  }

  if (doc.op === 'rewrite-from-version') {
    const sourceAccessError = validateVersionWasRead(opts, doc.artifact_id, doc.source_version);
    if (sourceAccessError) {
      return {
        code: 'artifact_precondition',
        message: `Failed to import artifacts: ${sourceAccessError}`,
        recoverable: true,
      };
    }

    if (!getArtifactVersionByNumber(db, doc.artifact_id, doc.source_version)) {
      return {
        code: 'artifact_precondition',
        message: `Failed to import artifacts: Version ${doc.source_version} not found for artifact ${doc.artifact_id}`,
        recoverable: true,
      };
    }
  }

  if (doc.op === 'restore' && !getArtifactVersionByNumber(db, doc.artifact_id, doc.restore_version)) {
    return {
      code: 'artifact_precondition',
      message: `Failed to import artifacts: Version ${doc.restore_version} not found for artifact ${doc.artifact_id}`,
      recoverable: true,
    };
  }

  return null;
}

function classifyCommitError(error: unknown): IngestErrorDetail {
  if (error instanceof ArtifactConflictError) {
    return {
      code: 'artifact_conflict',
      message: error.message,
      recoverable: false,
    };
  }

  return {
    code: 'artifact_import',
    message: `Failed to import artifacts: ${(error as Error).message}`,
    recoverable: false,
  };
}

function resolveBaseVersion(
  opts: IngestOptions,
  artifactId: number,
  baseVersion: ManifestBaseVersion
): { value: number } | { error: string } {
  const readVersion = opts.artifactReadAccess?.currentVersionsRead[artifactId];

  if (baseVersion === 'current') {
    if (typeof readVersion === 'number') {
      return { value: readVersion };
    }
    return {
      error: `Artifact ${artifactId} write requires read-current before write when base_version is "current"`,
    };
  }

  if (!opts.enforceCurrentRead) {
    return { value: baseVersion };
  }

  if (readVersion === baseVersion) {
    return { value: baseVersion };
  }

  return {
    error: `Artifact ${artifactId} write requires read-current of base_version=${baseVersion} before write. Prefer base_version="current" after read-current.`,
  };
}

function validateVersionWasRead(
  opts: IngestOptions,
  artifactId: number,
  version: number
): string | null {
  if (!opts.enforceCurrentRead) {
    return null;
  }

  const versionsRead = opts.artifactReadAccess?.versionsRead[artifactId] ?? [];
  if (versionsRead.includes(version)) {
    return null;
  }

  return `Artifact ${artifactId} rewrite-from-version requires read-version of source_version=${version} before write`;
}
