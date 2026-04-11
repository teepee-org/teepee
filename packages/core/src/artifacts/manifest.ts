import * as fs from 'fs';
import * as path from 'path';

export const VALID_ARTIFACT_KINDS = new Set(['plan', 'spec', 'adr', 'report', 'review']);
const MAX_FILE_COUNT = 20;
const MAX_MARKDOWN_SIZE = 512 * 1024; // 512 KB

export interface ManifestCreateEntry {
  op: 'create';
  kind: string;
  title: string;
  path: string;
}

export type ManifestBaseVersion = number | 'current';

export interface ManifestUpdateEntry {
  op: 'update';
  artifact_id: number;
  base_version: ManifestBaseVersion;
  path: string;
}

export interface ManifestRewriteFromVersionEntry {
  op: 'rewrite-from-version';
  artifact_id: number;
  base_version: ManifestBaseVersion;
  source_version: number;
  path: string;
}

export interface ManifestRestoreEntry {
  op: 'restore';
  artifact_id: number;
  base_version: ManifestBaseVersion;
  restore_version: number;
}

export type ManifestEntry =
  | ManifestCreateEntry
  | ManifestUpdateEntry
  | ManifestRewriteFromVersionEntry
  | ManifestRestoreEntry;

export interface ArtifactManifest {
  documents: ManifestEntry[];
}

export interface ManifestValidationError {
  message: string;
  entry?: number;
}

export function validateManifest(
  raw: unknown,
  outputDir: string
): { manifest: ArtifactManifest; errors: ManifestValidationError[] } | { manifest: null; errors: ManifestValidationError[] } {
  const errors: ManifestValidationError[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ message: 'Manifest must be a JSON object' });
    return { manifest: null, errors };
  }

  const obj = raw as Record<string, unknown>;

  const VALID_ROOT_KEYS = new Set(['documents']);
  for (const key of Object.keys(obj)) {
    if (!VALID_ROOT_KEYS.has(key)) {
      errors.push({ message: `Unknown root key '${key}'; only 'documents' is allowed` });
      return { manifest: null, errors };
    }
  }

  if (!Array.isArray(obj.documents)) {
    errors.push({ message: "Manifest must contain a 'documents' array" });
    return { manifest: null, errors };
  }

  if (obj.documents.length > MAX_FILE_COUNT) {
    errors.push({ message: `Manifest exceeds max file count (${MAX_FILE_COUNT})` });
    return { manifest: null, errors };
  }

  const validatedEntries: ManifestEntry[] = [];

  for (let i = 0; i < obj.documents.length; i++) {
    const doc = obj.documents[i];
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      errors.push({ message: 'Document entry must be an object', entry: i });
      continue;
    }

    const d = doc as Record<string, unknown>;

    if (d.op !== 'create' && d.op !== 'update' && d.op !== 'rewrite-from-version' && d.op !== 'restore') {
      errors.push({ message: `Invalid op '${d.op}', must be 'create', 'update', 'rewrite-from-version', or 'restore'`, entry: i });
      continue;
    }

    const VALID_CREATE_KEYS = new Set(['op', 'kind', 'title', 'path']);
    const VALID_UPDATE_KEYS = new Set(['op', 'artifact_id', 'base_version', 'path']);
    const VALID_REWRITE_KEYS = new Set(['op', 'artifact_id', 'base_version', 'source_version', 'path']);
    const VALID_RESTORE_KEYS = new Set(['op', 'artifact_id', 'base_version', 'restore_version']);
    const allowedKeys =
      d.op === 'create'
        ? VALID_CREATE_KEYS
        : d.op === 'update'
          ? VALID_UPDATE_KEYS
          : d.op === 'rewrite-from-version'
            ? VALID_REWRITE_KEYS
            : VALID_RESTORE_KEYS;
    const extraKeys = Object.keys(d).filter((k) => !allowedKeys.has(k));
    if (extraKeys.length > 0) {
      errors.push({ message: `Unknown keys in ${d.op} entry: ${extraKeys.join(', ')}`, entry: i });
      continue;
    }

    if (d.op === 'create') {
      if (typeof d.path !== 'string') {
        errors.push({ message: "Missing or invalid 'path'", entry: i });
        continue;
      }
      const pathError = validateFilePath(d.path, outputDir);
      if (pathError) {
        errors.push({ message: pathError, entry: i });
        continue;
      }
      if (typeof d.kind !== 'string' || !VALID_ARTIFACT_KINDS.has(d.kind)) {
        errors.push({ message: `Invalid kind '${d.kind}', must be one of: ${[...VALID_ARTIFACT_KINDS].join(', ')}`, entry: i });
        continue;
      }
      if (typeof d.title !== 'string' || d.title.trim().length === 0) {
        errors.push({ message: "Missing or empty 'title'", entry: i });
        continue;
      }
      validatedEntries.push({ op: 'create', kind: d.kind, title: d.title.trim(), path: d.path });
    } else if (d.op === 'update' || d.op === 'rewrite-from-version') {
      if (typeof d.path !== 'string') {
        errors.push({ message: "Missing or invalid 'path'", entry: i });
        continue;
      }
      const pathError = validateFilePath(d.path, outputDir);
      if (pathError) {
        errors.push({ message: pathError, entry: i });
        continue;
      }
      if (typeof d.artifact_id !== 'number' || !Number.isInteger(d.artifact_id)) {
        errors.push({ message: "Missing or invalid 'artifact_id'", entry: i });
        continue;
      }
      if (!isBaseVersionRef(d.base_version)) {
        errors.push({ message: "Missing or invalid 'base_version'", entry: i });
        continue;
      }
      if (d.op === 'rewrite-from-version') {
        if (typeof d.source_version !== 'number' || !Number.isInteger(d.source_version)) {
          errors.push({ message: "Missing or invalid 'source_version'", entry: i });
          continue;
        }
        validatedEntries.push({
          op: 'rewrite-from-version',
          artifact_id: d.artifact_id,
          base_version: d.base_version,
          source_version: d.source_version,
          path: d.path,
        });
        continue;
      }
      validatedEntries.push({ op: 'update', artifact_id: d.artifact_id, base_version: d.base_version, path: d.path });
    } else {
      if (typeof d.artifact_id !== 'number' || !Number.isInteger(d.artifact_id)) {
        errors.push({ message: "Missing or invalid 'artifact_id'", entry: i });
        continue;
      }
      if (!isBaseVersionRef(d.base_version)) {
        errors.push({ message: "Missing or invalid 'base_version'", entry: i });
        continue;
      }
      if (typeof d.restore_version !== 'number' || !Number.isInteger(d.restore_version)) {
        errors.push({ message: "Missing or invalid 'restore_version'", entry: i });
        continue;
      }
      validatedEntries.push({
        op: 'restore',
        artifact_id: d.artifact_id,
        base_version: d.base_version,
        restore_version: d.restore_version,
      });
    }
  }

  if (errors.length > 0) {
    return { manifest: null, errors };
  }

  return { manifest: { documents: validatedEntries }, errors: [] };
}

function isBaseVersionRef(value: unknown): value is ManifestBaseVersion {
  return value === 'current' || (typeof value === 'number' && Number.isInteger(value));
}

function validateFilePath(filePath: string, outputDir: string): string | null {
  if (path.isAbsolute(filePath)) {
    return `Path must be relative: '${filePath}'`;
  }

  if (filePath.includes('..')) {
    return `Path traversal not allowed: '${filePath}'`;
  }

  if (!filePath.startsWith('files/')) {
    return `Path must be under 'files/': '${filePath}'`;
  }

  const fullPath = path.join(outputDir, filePath);
  const resolvedFull = path.resolve(fullPath);
  const resolvedBase = path.resolve(outputDir, 'files');
  if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) {
    return `Path escapes output directory: '${filePath}'`;
  }

  return null;
}

export function readManifestFile(
  outputDir: string
): { raw: unknown; error?: string } {
  const manifestPath = path.join(outputDir, 'artifacts.json');
  if (!fs.existsSync(manifestPath)) {
    return { raw: null };
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return { raw: JSON.parse(content) };
  } catch (e: any) {
    return { raw: null, error: `Failed to parse artifacts.json: ${e.message}` };
  }
}

export function readArtifactFile(
  outputDir: string,
  filePath: string
): { body: string; error?: string } {
  const fullPath = path.join(outputDir, filePath);

  // Check intermediate directories for symlinks
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const partial = path.join(outputDir, ...parts.slice(0, i));
    try {
      if (fs.lstatSync(partial).isSymbolicLink()) {
        return { body: '', error: `Symlinks not allowed in path: '${parts.slice(0, i).join('/')}'` };
      }
    } catch {
      // directory doesn't exist, will fail below
    }
  }

  // Symlink check on file itself
  try {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      return { body: '', error: `Symlinks not allowed: '${filePath}'` };
    }
    if (stat.size > MAX_MARKDOWN_SIZE) {
      return { body: '', error: `File exceeds max size (${MAX_MARKDOWN_SIZE} bytes): '${filePath}'` };
    }
  } catch {
    return { body: '', error: `File not found: '${filePath}'` };
  }

  try {
    return { body: fs.readFileSync(fullPath, 'utf-8') };
  } catch (e: any) {
    return { body: '', error: `Failed to read '${filePath}': ${e.message}` };
  }
}
