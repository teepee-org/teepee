import type { Database as DatabaseType } from 'better-sqlite3';

export interface ArtifactRow {
  id: number;
  topic_id: number;
  artifact_class: string;
  kind: string;
  title: string;
  status: string;
  canonical_source: string;
  current_version_id: number | null;
  promoted_repo_path: string | null;
  promoted_commit_sha: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  created_by_user_email: string | null;
  created_by_job_id: number | null;
  created_from_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionRow {
  id: number;
  artifact_id: number;
  version: number;
  content_type: string;
  body: string;
  summary: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  created_by_user_email: string | null;
  created_by_job_id: number | null;
  source_message_id: number | null;
  created_at: string;
}

export interface MessageArtifactRow {
  message_id: number;
  artifact_id: number;
  artifact_version_id: number;
  relation: string;
}

export interface CreateDocumentArtifactParams {
  topicId: number;
  kind: string;
  title: string;
  body: string;
  summary?: string;
  createdByAgent?: string;
  createdByUserId?: string;
  createdByUserEmail?: string;
  createdByJobId?: number;
  createdFromMessageId?: number;
}

export interface UpdateDocumentArtifactParams {
  artifactId: number;
  expectedTopicId?: number;
  baseVersion: number;
  body: string;
  summary?: string;
  createdByAgent?: string;
  createdByUserId?: string;
  createdByUserEmail?: string;
  createdByJobId?: number;
  sourceMessageId?: number;
}

export interface RestoreDocumentArtifactParams {
  artifactId: number;
  expectedTopicId?: number;
  baseVersion: number;
  restoreVersion: number;
  summary?: string;
  createdByAgent?: string;
  createdByUserId?: string;
  createdByUserEmail?: string;
  createdByJobId?: number;
  sourceMessageId?: number;
}

export interface RewriteDocumentArtifactFromVersionParams {
  artifactId: number;
  expectedTopicId?: number;
  baseVersion: number;
  sourceVersion: number;
  body: string;
  summary?: string;
  createdByAgent?: string;
  createdByUserId?: string;
  createdByUserEmail?: string;
  createdByJobId?: number;
  sourceMessageId?: number;
}

export interface CreateArtifactResult {
  artifact: ArtifactRow;
  version: ArtifactVersionRow;
}

export interface UpdateArtifactResult {
  artifact: ArtifactRow;
  version: ArtifactVersionRow;
}

export class ArtifactConflictError extends Error {
  constructor(
    public artifactId: number,
    public expectedVersion: number,
    public actualVersion: number
  ) {
    super(
      `Version conflict on artifact ${artifactId}: expected base_version=${expectedVersion}, current is ${actualVersion}`
    );
    this.name = 'ArtifactConflictError';
  }
}

export function createDocumentArtifact(
  db: DatabaseType,
  params: CreateDocumentArtifactParams
): CreateArtifactResult {
  const txn = db.transaction(() => {
    const artifactResult = db
      .prepare(
        `INSERT INTO artifacts (topic_id, artifact_class, kind, title, status, canonical_source, created_by_agent, created_by_user_id, created_by_user_email, created_by_job_id, created_from_message_id)
         VALUES (?, 'document', ?, ?, 'draft', 'db', ?, ?, ?, ?, ?)`
      )
      .run(
        params.topicId,
        params.kind,
        params.title,
        params.createdByAgent ?? null,
        params.createdByUserId ?? null,
        params.createdByUserEmail ?? null,
        params.createdByJobId ?? null,
        params.createdFromMessageId ?? null
      );

    const artifactId = Number(artifactResult.lastInsertRowid);

    const versionResult = db
      .prepare(
        `INSERT INTO artifact_versions (artifact_id, version, content_type, body, summary, created_by_agent, created_by_user_id, created_by_user_email, created_by_job_id, source_message_id)
         VALUES (?, 1, 'text/markdown', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        params.body,
        params.summary ?? null,
        params.createdByAgent ?? null,
        params.createdByUserId ?? null,
        params.createdByUserEmail ?? null,
        params.createdByJobId ?? null,
        params.createdFromMessageId ?? null
      );

    const versionId = Number(versionResult.lastInsertRowid);

    db.prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`).run(
      versionId,
      artifactId
    );

    const artifact = db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(artifactId) as ArtifactRow;
    const version = db
      .prepare(`SELECT * FROM artifact_versions WHERE id = ?`)
      .get(versionId) as ArtifactVersionRow;

    return { artifact, version };
  });

  return txn();
}

export function updateDocumentArtifact(
  db: DatabaseType,
  params: UpdateDocumentArtifactParams
): UpdateArtifactResult {
  const txn = db.transaction(() => {
    const artifact = db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(params.artifactId) as ArtifactRow | undefined;

    if (!artifact) {
      throw new Error(`Artifact ${params.artifactId} not found`);
    }

    if (params.expectedTopicId !== undefined && artifact.topic_id !== params.expectedTopicId) {
      throw new Error(`Artifact ${params.artifactId} does not belong to topic ${params.expectedTopicId}`);
    }

    const currentVersion = db
      .prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1`)
      .get(params.artifactId) as ArtifactVersionRow | undefined;

    const currentVersionNum = currentVersion?.version ?? 0;

    if (params.baseVersion !== currentVersionNum) {
      throw new ArtifactConflictError(
        params.artifactId,
        params.baseVersion,
        currentVersionNum
      );
    }

    const newVersionNum = currentVersionNum + 1;

    const versionResult = db
      .prepare(
        `INSERT INTO artifact_versions (artifact_id, version, content_type, body, summary, created_by_agent, created_by_user_id, created_by_user_email, created_by_job_id, source_message_id)
         VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.artifactId,
        newVersionNum,
        params.body,
        params.summary ?? null,
        params.createdByAgent ?? null,
        params.createdByUserId ?? null,
        params.createdByUserEmail ?? null,
        params.createdByJobId ?? null,
        params.sourceMessageId ?? null
      );

    const versionId = Number(versionResult.lastInsertRowid);

    db.prepare(
      `UPDATE artifacts SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(versionId, params.artifactId);

    const updatedArtifact = db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(params.artifactId) as ArtifactRow;
    const version = db
      .prepare(`SELECT * FROM artifact_versions WHERE id = ?`)
      .get(versionId) as ArtifactVersionRow;

    return { artifact: updatedArtifact, version };
  });

  return txn();
}

export function listTopicArtifacts(
  db: DatabaseType,
  topicId: number
): ArtifactRow[] {
  return db
    .prepare(`SELECT * FROM artifacts WHERE topic_id = ? ORDER BY id`)
    .all(topicId) as ArtifactRow[];
}

export function searchArtifacts(
  db: DatabaseType,
  query: string,
  limit: number
): ArtifactRow[] {
  if (!query) {
    return db
      .prepare(`SELECT * FROM artifacts ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as ArtifactRow[];
  }
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM artifacts
       WHERE title LIKE ? OR kind LIKE ? OR promoted_repo_path LIKE ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(pattern, pattern, pattern, limit) as ArtifactRow[];
}

export function getArtifact(
  db: DatabaseType,
  artifactId: number
): ArtifactRow | undefined {
  return db
    .prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .get(artifactId) as ArtifactRow | undefined;
}

export function getArtifactVersions(
  db: DatabaseType,
  artifactId: number
): ArtifactVersionRow[] {
  return db
    .prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version`
    )
    .all(artifactId) as ArtifactVersionRow[];
}

export function getArtifactVersion(
  db: DatabaseType,
  artifactId: number,
  versionId: number
): ArtifactVersionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND id = ?`
    )
    .get(artifactId, versionId) as ArtifactVersionRow | undefined;
}

export function getArtifactVersionByNumber(
  db: DatabaseType,
  artifactId: number,
  versionNumber: number
): ArtifactVersionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`
    )
    .get(artifactId, versionNumber) as ArtifactVersionRow | undefined;
}

export function getCurrentArtifactVersion(
  db: DatabaseType,
  artifactId: number
): ArtifactVersionRow | undefined {
  return db
    .prepare(
      `SELECT v.*
       FROM artifacts a
       JOIN artifact_versions v ON v.id = a.current_version_id
       WHERE a.id = ?`
    )
    .get(artifactId) as ArtifactVersionRow | undefined;
}

export function restoreDocumentArtifact(
  db: DatabaseType,
  params: RestoreDocumentArtifactParams
): UpdateArtifactResult {
  const restoreSource = getArtifactVersionByNumber(
    db,
    params.artifactId,
    params.restoreVersion
  );

  if (!restoreSource) {
    throw new Error(
      `Version ${params.restoreVersion} not found for artifact ${params.artifactId}`
    );
  }

  return updateDocumentArtifact(db, {
    artifactId: params.artifactId,
    expectedTopicId: params.expectedTopicId,
    baseVersion: params.baseVersion,
    body: restoreSource.body,
    summary: params.summary,
    createdByAgent: params.createdByAgent,
    createdByUserId: params.createdByUserId,
    createdByUserEmail: params.createdByUserEmail,
    createdByJobId: params.createdByJobId,
    sourceMessageId: params.sourceMessageId,
  });
}

export function rewriteDocumentArtifactFromVersion(
  db: DatabaseType,
  params: RewriteDocumentArtifactFromVersionParams
): UpdateArtifactResult {
  const sourceVersion = getArtifactVersionByNumber(
    db,
    params.artifactId,
    params.sourceVersion
  );

  if (!sourceVersion) {
    throw new Error(
      `Version ${params.sourceVersion} not found for artifact ${params.artifactId}`
    );
  }

  return updateDocumentArtifact(db, {
    artifactId: params.artifactId,
    expectedTopicId: params.expectedTopicId,
    baseVersion: params.baseVersion,
    body: params.body,
    summary: params.summary,
    createdByAgent: params.createdByAgent,
    createdByUserId: params.createdByUserId,
    createdByUserEmail: params.createdByUserEmail,
    createdByJobId: params.createdByJobId,
    sourceMessageId: params.sourceMessageId,
  });
}

export function linkMessageArtifact(
  db: DatabaseType,
  messageId: number,
  artifactId: number,
  artifactVersionId: number,
  relation: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO message_artifacts (message_id, artifact_id, artifact_version_id, relation) VALUES (?, ?, ?, ?)`
  ).run(messageId, artifactId, artifactVersionId, relation);
}

export function getMessageArtifacts(
  db: DatabaseType,
  messageId: number
): MessageArtifactRow[] {
  return db
    .prepare(
      `SELECT * FROM message_artifacts WHERE message_id = ? ORDER BY artifact_id`
    )
    .all(messageId) as MessageArtifactRow[];
}

export interface ArtifactContextInfo {
  id: number;
  kind: string;
  title: string;
  current_version: number;
}

export function listTopicArtifactContext(
  db: DatabaseType,
  topicId: number
): ArtifactContextInfo[] {
  return db
    .prepare(
      `SELECT a.id, a.kind, a.title, COALESCE(v.version, 0) as current_version
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.current_version_id
       WHERE a.topic_id = ?
       ORDER BY a.id`
    )
    .all(topicId) as ArtifactContextInfo[];
}

export interface ScopedArtifactContextInfo extends ArtifactContextInfo {
  topic_id: number;
  inherited: boolean;
}

function normalizeArtifactSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function buildScopedArtifactRows(
  db: DatabaseType,
  topicLineage: number[],
  query: string
): ArtifactRow[] {
  if (topicLineage.length === 0) return [];

  const placeholders = topicLineage.map(() => '?').join(',');
  const normalizedQuery = normalizeArtifactSearchQuery(query);

  if (!normalizedQuery) {
    return db
      .prepare(`SELECT * FROM artifacts WHERE topic_id IN (${placeholders})`)
      .all(...topicLineage) as ArtifactRow[];
  }

  const pattern = `%${normalizedQuery}%`;
  return db
    .prepare(
      `SELECT * FROM artifacts
       WHERE topic_id IN (${placeholders})
         AND (
           lower(title) LIKE ?
           OR lower(kind) LIKE ?
           OR lower(COALESCE(promoted_repo_path, '')) LIKE ?
         )`
    )
    .all(...topicLineage, pattern, pattern, pattern) as ArtifactRow[];
}

function compareScopedArtifacts(
  a: ArtifactRow,
  b: ArtifactRow,
  distanceMap: Map<number, number>,
  query: string
): number {
  const distanceA = distanceMap.get(a.topic_id) ?? Number.MAX_SAFE_INTEGER;
  const distanceB = distanceMap.get(b.topic_id) ?? Number.MAX_SAFE_INTEGER;
  if (distanceA !== distanceB) return distanceA - distanceB;

  const normalizedQuery = normalizeArtifactSearchQuery(query);
  const matchA = getScopedArtifactMatchScore(a, normalizedQuery);
  const matchB = getScopedArtifactMatchScore(b, normalizedQuery);
  if (matchA !== matchB) return matchB - matchA;

  if (a.updated_at !== b.updated_at) {
    return b.updated_at.localeCompare(a.updated_at);
  }

  return b.id - a.id;
}

function getScopedArtifactMatchScore(
  artifact: ArtifactRow,
  normalizedQuery: string
): number {
  if (!normalizedQuery) return 0;

  const title = artifact.title.toLowerCase();
  const kind = artifact.kind.toLowerCase();
  const repoPath = artifact.promoted_repo_path?.toLowerCase() ?? '';

  if (title === normalizedQuery) return 400;
  if (title.startsWith(normalizedQuery)) return 300;
  if (title.includes(normalizedQuery)) return 200;
  if (kind === normalizedQuery || repoPath === normalizedQuery) return 150;
  if (kind.startsWith(normalizedQuery) || repoPath.startsWith(normalizedQuery)) return 120;
  if (kind.includes(normalizedQuery) || repoPath.includes(normalizedQuery)) return 100;
  return 0;
}

/**
 * List artifacts visible to a topic: own artifacts + ancestors' artifacts.
 * Ordered by lineage distance (current first), then by id.
 * Cap total results to `limit`.
 */
export function listScopedArtifactContext(
  db: DatabaseType,
  topicLineage: number[],
  limit = 30
): ScopedArtifactContextInfo[] {
  if (topicLineage.length === 0) return [];
  const currentTopicId = topicLineage[0];
  const distanceMap = new Map(topicLineage.map((id, index) => [id, index]));
  const placeholders = topicLineage.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.title, a.topic_id, a.updated_at, COALESCE(v.version, 0) as current_version
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.current_version_id
       WHERE a.topic_id IN (${placeholders})`
    )
    .all(...topicLineage) as Array<ArtifactContextInfo & { topic_id: number; updated_at: string }>;

  rows.sort((a, b) => {
    const distanceA = distanceMap.get(a.topic_id) ?? Number.MAX_SAFE_INTEGER;
    const distanceB = distanceMap.get(b.topic_id) ?? Number.MAX_SAFE_INTEGER;
    if (distanceA !== distanceB) return distanceA - distanceB;
    if (a.updated_at !== b.updated_at) return b.updated_at.localeCompare(a.updated_at);
    return b.id - a.id;
  });

  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    current_version: r.current_version,
    topic_id: r.topic_id,
    inherited: r.topic_id !== currentTopicId,
  }));
}

/**
 * List artifacts scoped to a topic lineage.
 * Ordered by current topic first, then nearest parent, then recency.
 */
export function listScopedArtifacts(
  db: DatabaseType,
  topicLineage: number[],
  limit = 200
): ArtifactRow[] {
  const rows = buildScopedArtifactRows(db, topicLineage, '');
  const distanceMap = new Map(topicLineage.map((id, index) => [id, index]));
  rows.sort((a, b) => compareScopedArtifacts(a, b, distanceMap, ''));
  return rows.slice(0, limit);
}

/**
 * Search artifacts scoped to a topic lineage.
 * Returns artifacts belonging to any topic in the lineage, ranked by lineage distance first,
 * then title/path match quality, then recency.
 */
export function searchScopedArtifacts(
  db: DatabaseType,
  topicLineage: number[],
  query: string,
  limit: number
): ArtifactRow[] {
  const rows = buildScopedArtifactRows(db, topicLineage, query);
  const distanceMap = new Map(topicLineage.map((id, index) => [id, index]));
  rows.sort((a, b) => compareScopedArtifacts(a, b, distanceMap, query));
  return rows.slice(0, limit);
}

/** Count artifacts per topic (for sidebar indicators). */
export function countArtifactsByTopic(db: DatabaseType): Map<number, number> {
  const rows = db
    .prepare('SELECT topic_id, COUNT(*) as cnt FROM artifacts GROUP BY topic_id')
    .all() as Array<{ topic_id: number; cnt: number }>;
  return new Map(rows.map((r) => [r.topic_id, r.cnt]));
}

export interface EnrichedMessageArtifact {
  artifact_id: number;
  artifact_version_id: number;
  relation: string;
  kind: string;
  title: string;
  version: number;
}

export function getEnrichedMessageArtifacts(
  db: DatabaseType,
  messageId: number
): EnrichedMessageArtifact[] {
  return db
    .prepare(
      `SELECT ma.artifact_id, ma.artifact_version_id, ma.relation,
              a.kind, a.title, v.version
       FROM message_artifacts ma
       JOIN artifacts a ON a.id = ma.artifact_id
       JOIN artifact_versions v ON v.id = ma.artifact_version_id
       WHERE ma.message_id = ?
       ORDER BY ma.artifact_id`
    )
    .all(messageId) as EnrichedMessageArtifact[];
}

export function promoteArtifact(
  db: DatabaseType,
  artifactId: number,
  repoPath: string,
  commitSha: string
): void {
  db.prepare(
    `UPDATE artifacts SET canonical_source = 'repo', promoted_repo_path = ?, promoted_commit_sha = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(repoPath, commitSha, artifactId);
}
