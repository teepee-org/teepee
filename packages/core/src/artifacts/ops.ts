import * as fs from 'fs';
import * as path from 'path';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  getArtifact,
  getArtifactVersionByNumber,
  getCurrentArtifactVersion,
  type ArtifactVersionRow,
} from '../db/artifacts.js';

export const MAX_ARTIFACT_OPS_PER_ROUND = 5;
export const MAX_ARTIFACT_OP_ROUNDS = 3;

export type ArtifactVersionRef = number | 'current';
export type ArtifactDiffFormat = 'summary' | 'unified';

export interface ReadCurrentOperation {
  op_id: string;
  op: 'read-current';
  artifact_id: number;
}

export interface ReadVersionOperation {
  op_id: string;
  op: 'read-version';
  artifact_id: number;
  version: ArtifactVersionRef;
}

export interface ReadDiffOperation {
  op_id: string;
  op: 'read-diff';
  artifact_id: number;
  from_version: ArtifactVersionRef;
  to_version: ArtifactVersionRef;
  format?: ArtifactDiffFormat;
}

export type ArtifactReadOperation =
  | ReadCurrentOperation
  | ReadVersionOperation
  | ReadDiffOperation;

export interface ArtifactOpsFile {
  operations: ArtifactReadOperation[];
}

export interface ArtifactOpValidationError {
  message: string;
  entry?: number;
}

export interface ArtifactReadAccessState {
  currentVersionsRead: Record<number, number>;
  versionsRead: Record<number, number[]>;
}

interface ArtifactOpSuccessBase {
  op_id: string;
  ok: true;
  artifact_id: number;
}

interface ArtifactOpFailure {
  op_id: string;
  ok: false;
  op: ArtifactReadOperation['op'];
  artifact_id?: number;
  error: string;
}

export interface ReadCurrentResult extends ArtifactOpSuccessBase {
  op: 'read-current';
  version: number;
  content_type: string;
  truncated: false;
  body: string;
}

export interface ReadVersionResult extends ArtifactOpSuccessBase {
  op: 'read-version';
  version: number;
  content_type: string;
  truncated: false;
  body: string;
}

export interface ReadDiffResult extends ArtifactOpSuccessBase {
  op: 'read-diff';
  from_version: number;
  to_version: number;
  format: ArtifactDiffFormat;
  summary: string;
  diff?: string;
  stats: {
    added_lines: number;
    removed_lines: number;
  };
  truncated: false;
}

export type ArtifactOpResult =
  | ArtifactOpFailure
  | ReadCurrentResult
  | ReadVersionResult
  | ReadDiffResult;

export interface ExecuteArtifactOpsResult {
  results: ArtifactOpResult[];
  accessState: ArtifactReadAccessState;
}

export function readArtifactOpsFile(
  outputDir: string
): { raw: unknown; error?: string } {
  const opsPath = path.join(outputDir, 'artifact-ops.json');
  if (!fs.existsSync(opsPath)) {
    return { raw: null };
  }

  try {
    const content = fs.readFileSync(opsPath, 'utf-8');
    return { raw: JSON.parse(content) };
  } catch (e: any) {
    return { raw: null, error: `Failed to parse artifact-ops.json: ${e.message}` };
  }
}

export function validateArtifactOps(
  raw: unknown
): { ops: ArtifactReadOperation[]; errors: ArtifactOpValidationError[] } | { ops: null; errors: ArtifactOpValidationError[] } {
  const errors: ArtifactOpValidationError[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ message: 'Artifact ops file must be a JSON object' });
    return { ops: null, errors };
  }

  const obj = raw as Record<string, unknown>;
  const validRootKeys = new Set(['operations']);
  for (const key of Object.keys(obj)) {
    if (!validRootKeys.has(key)) {
      errors.push({ message: `Unknown root key '${key}'; only 'operations' is allowed` });
      return { ops: null, errors };
    }
  }

  if (!Array.isArray(obj.operations)) {
    errors.push({ message: "Artifact ops file must contain an 'operations' array" });
    return { ops: null, errors };
  }

  if (obj.operations.length === 0) {
    errors.push({ message: 'Artifact ops file must contain at least one operation' });
    return { ops: null, errors };
  }

  if (obj.operations.length > MAX_ARTIFACT_OPS_PER_ROUND) {
    errors.push({ message: `Artifact ops file exceeds max operations per round (${MAX_ARTIFACT_OPS_PER_ROUND})` });
    return { ops: null, errors };
  }

  const validated: ArtifactReadOperation[] = [];
  const opIds = new Set<string>();

  for (let i = 0; i < obj.operations.length; i++) {
    const item = obj.operations[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({ message: 'Operation entry must be an object', entry: i });
      continue;
    }

    const op = item as Record<string, unknown>;
    if (typeof op.op_id !== 'string' || op.op_id.trim().length === 0) {
      errors.push({ message: "Missing or invalid 'op_id'", entry: i });
      continue;
    }
    if (opIds.has(op.op_id)) {
      errors.push({ message: `Duplicate op_id '${op.op_id}'`, entry: i });
      continue;
    }
    opIds.add(op.op_id);

    if (op.op === 'read-current') {
      const allowedKeys = new Set(['op_id', 'op', 'artifact_id']);
      const extraKeys = Object.keys(op).filter((key) => !allowedKeys.has(key));
      if (extraKeys.length > 0) {
        errors.push({ message: `Unknown keys in read-current entry: ${extraKeys.join(', ')}`, entry: i });
        continue;
      }
      if (!isInteger(op.artifact_id)) {
        errors.push({ message: "Missing or invalid 'artifact_id'", entry: i });
        continue;
      }
      validated.push({
        op_id: op.op_id.trim(),
        op: 'read-current',
        artifact_id: op.artifact_id,
      });
      continue;
    }

    if (op.op === 'read-version') {
      const allowedKeys = new Set(['op_id', 'op', 'artifact_id', 'version']);
      const extraKeys = Object.keys(op).filter((key) => !allowedKeys.has(key));
      if (extraKeys.length > 0) {
        errors.push({ message: `Unknown keys in read-version entry: ${extraKeys.join(', ')}`, entry: i });
        continue;
      }
      if (!isInteger(op.artifact_id)) {
        errors.push({ message: "Missing or invalid 'artifact_id'", entry: i });
        continue;
      }
      if (!isVersionRef(op.version)) {
        errors.push({ message: "Missing or invalid 'version'", entry: i });
        continue;
      }
      validated.push({
        op_id: op.op_id.trim(),
        op: 'read-version',
        artifact_id: op.artifact_id,
        version: op.version,
      });
      continue;
    }

    if (op.op === 'read-diff') {
      const allowedKeys = new Set(['op_id', 'op', 'artifact_id', 'from_version', 'to_version', 'format']);
      const extraKeys = Object.keys(op).filter((key) => !allowedKeys.has(key));
      if (extraKeys.length > 0) {
        errors.push({ message: `Unknown keys in read-diff entry: ${extraKeys.join(', ')}`, entry: i });
        continue;
      }
      if (!isInteger(op.artifact_id)) {
        errors.push({ message: "Missing or invalid 'artifact_id'", entry: i });
        continue;
      }
      if (!isVersionRef(op.from_version)) {
        errors.push({ message: "Missing or invalid 'from_version'", entry: i });
        continue;
      }
      if (!isVersionRef(op.to_version)) {
        errors.push({ message: "Missing or invalid 'to_version'", entry: i });
        continue;
      }
      if (
        op.format !== undefined &&
        op.format !== 'summary' &&
        op.format !== 'unified'
      ) {
        errors.push({ message: "Invalid 'format', must be 'summary' or 'unified'", entry: i });
        continue;
      }
      validated.push({
        op_id: op.op_id.trim(),
        op: 'read-diff',
        artifact_id: op.artifact_id,
        from_version: op.from_version,
        to_version: op.to_version,
        format: op.format as ArtifactDiffFormat | undefined,
      });
      continue;
    }

    errors.push({
      message: `Invalid op '${String(op.op)}', must be 'read-current', 'read-version', or 'read-diff'`,
      entry: i,
    });
  }

  if (errors.length > 0) {
    return { ops: null, errors };
  }

  return { ops: validated, errors: [] };
}

export function executeArtifactOps(
  db: DatabaseType,
  topicScope: number | number[],
  ops: ArtifactReadOperation[],
  previousState: ArtifactReadAccessState = { currentVersionsRead: {}, versionsRead: {} }
): ExecuteArtifactOpsResult {
  const results: ArtifactOpResult[] = [];
  const readableTopicIds = normalizeTopicScope(topicScope);
  const accessState: ArtifactReadAccessState = {
    currentVersionsRead: { ...previousState.currentVersionsRead },
    versionsRead: cloneVersionsRead(previousState.versionsRead),
  };

  for (const op of ops) {
    try {
      if (op.op === 'read-current') {
        const version = resolveArtifactVersion(db, readableTopicIds, op.artifact_id, 'current');
        accessState.currentVersionsRead[op.artifact_id] = version.version;
        recordVersionRead(accessState, op.artifact_id, version.version);
        results.push({
          op_id: op.op_id,
          ok: true,
          op: 'read-current',
          artifact_id: op.artifact_id,
          version: version.version,
          content_type: version.content_type,
          truncated: false,
          body: version.body,
        });
        continue;
      }

      if (op.op === 'read-version') {
        const version = resolveArtifactVersion(db, readableTopicIds, op.artifact_id, op.version);
        if (op.version === 'current') {
          accessState.currentVersionsRead[op.artifact_id] = version.version;
        }
        recordVersionRead(accessState, op.artifact_id, version.version);
        results.push({
          op_id: op.op_id,
          ok: true,
          op: 'read-version',
          artifact_id: op.artifact_id,
          version: version.version,
          content_type: version.content_type,
          truncated: false,
          body: version.body,
        });
        continue;
      }

      const fromVersion = resolveArtifactVersion(
        db,
        readableTopicIds,
        op.artifact_id,
        op.from_version
      );
      const toVersion = resolveArtifactVersion(
        db,
        readableTopicIds,
        op.artifact_id,
        op.to_version
      );
      const diff = summarizeDiff(fromVersion.body, toVersion.body);
      const format = op.format ?? 'summary';

      results.push({
        op_id: op.op_id,
        ok: true,
        op: 'read-diff',
        artifact_id: op.artifact_id,
        from_version: fromVersion.version,
        to_version: toVersion.version,
        format,
        summary:
          diff.addedLines === 0 && diff.removedLines === 0
            ? `No differences between v${fromVersion.version} and v${toVersion.version}.`
            : `Diff from v${fromVersion.version} to v${toVersion.version}: ${diff.addedLines} line(s) added, ${diff.removedLines} removed.`,
        diff:
          format === 'unified'
            ? buildUnifiedDiff(
                fromVersion.body,
                toVersion.body,
                `v${fromVersion.version}`,
                `v${toVersion.version}`
              )
            : undefined,
        stats: {
          added_lines: diff.addedLines,
          removed_lines: diff.removedLines,
        },
        truncated: false,
      });
    } catch (e: any) {
      results.push({
        op_id: op.op_id,
        ok: false,
        op: op.op,
        artifact_id: op.artifact_id,
        error: e.message,
      });
    }
  }

  return { results, accessState };
}

function cloneVersionsRead(
  versionsRead: Record<number, number[]> | undefined
): Record<number, number[]> {
  const cloned: Record<number, number[]> = {};
  if (!versionsRead) {
    return cloned;
  }
  for (const [artifactId, versions] of Object.entries(versionsRead)) {
    cloned[Number(artifactId)] = [...versions];
  }
  return cloned;
}

function recordVersionRead(
  accessState: ArtifactReadAccessState,
  artifactId: number,
  version: number
): void {
  const versions = accessState.versionsRead[artifactId] ?? [];
  if (!versions.includes(version)) {
    accessState.versionsRead[artifactId] = [...versions, version].sort((a, b) => a - b);
  }
}

export function formatArtifactOpResults(results: ArtifactOpResult[]): string {
  return JSON.stringify({ results }, null, 2);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isVersionRef(value: unknown): value is ArtifactVersionRef {
  return value === 'current' || isInteger(value);
}

function resolveArtifactVersion(
  db: DatabaseType,
  readableTopicIds: number[],
  artifactId: number,
  versionRef: ArtifactVersionRef
): ArtifactVersionRow {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) {
    throw new Error(`Artifact ${artifactId} not found`);
  }
  if (!readableTopicIds.includes(artifact.topic_id)) {
    const sourceTopicId = readableTopicIds[0] ?? 'unknown';
    throw new Error(`Artifact ${artifactId} is not readable from topic ${sourceTopicId}`);
  }

  const version =
    versionRef === 'current'
      ? getCurrentArtifactVersion(db, artifactId)
      : getArtifactVersionByNumber(db, artifactId, versionRef);

  if (!version) {
    const versionLabel =
      versionRef === 'current' ? 'current version' : `version ${versionRef}`;
    throw new Error(`${versionLabel} not found for artifact ${artifactId}`);
  }

  return version;
}

function normalizeTopicScope(topicScope: number | number[]): number[] {
  return Array.isArray(topicScope) ? topicScope : [topicScope];
}

function summarizeDiff(fromBody: string, toBody: string): {
  addedLines: number;
  removedLines: number;
} {
  const fromLines = splitLines(fromBody);
  const toLines = splitLines(toBody);
  let prefix = 0;
  while (
    prefix < fromLines.length &&
    prefix < toLines.length &&
    fromLines[prefix] === toLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < fromLines.length - prefix &&
    suffix < toLines.length - prefix &&
    fromLines[fromLines.length - 1 - suffix] ===
      toLines[toLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    removedLines: fromLines.length - prefix - suffix,
    addedLines: toLines.length - prefix - suffix,
  };
}

function buildUnifiedDiff(
  fromBody: string,
  toBody: string,
  fromLabel: string,
  toLabel: string
): string {
  if (fromBody === toBody) {
    return `--- ${fromLabel}\n+++ ${toLabel}\n@@ -1,0 +1,0 @@`;
  }

  const fromLines = splitLines(fromBody);
  const toLines = splitLines(toBody);
  let prefix = 0;
  while (
    prefix < fromLines.length &&
    prefix < toLines.length &&
    fromLines[prefix] === toLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < fromLines.length - prefix &&
    suffix < toLines.length - prefix &&
    fromLines[fromLines.length - 1 - suffix] ===
      toLines[toLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = fromLines.slice(prefix, fromLines.length - suffix);
  const added = toLines.slice(prefix, toLines.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const oldCount = removed.length;
  const newCount = added.length;

  const lines = [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return lines.join('\n');
}

function splitLines(body: string): string[] {
  return body.split('\n');
}
