import * as crypto from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SCHEMA } from './schema.js';

/**
 * Run incremental migrations.
 * Safe to call multiple times — checks column existence before altering.
 */
export function runMigrations(db: DatabaseType): void {
  const tableExists = (name: string): boolean =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(name));
  const hasColumn = (table: string, column: string): boolean =>
    tableExists(table) && (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

  const topicCols = db.prepare("PRAGMA table_info(topics)").all() as { name: string }[];
  const topicColNames = new Set(topicCols.map((c) => c.name));

  if (!topicColNames.has('archived_at')) {
    db.exec(`ALTER TABLE topics ADD COLUMN archived_at TEXT;`);
  }

  if (!topicColNames.has('parent_topic_id')) {
    db.exec(`ALTER TABLE topics ADD COLUMN parent_topic_id INTEGER REFERENCES topics(id);`);
  }

  if (!topicColNames.has('sort_order')) {
    db.exec(`ALTER TABLE topics ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;`);
  }

  // Backfill: give topics with degenerate sort_order a deterministic order based on id.
  // Runs unconditionally so databases that got the column before the backfill was added are fixed.
  db.exec(`UPDATE topics SET sort_order = id WHERE sort_order = 0;`);

  const userCols = tableExists('users')
    ? db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    : [];
  const userColNames = new Set(userCols.map((c) => c.name));

  if (!userColNames.has('id')) {
    db.exec(`
      CREATE TABLE users_v2 (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        handle TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('owner', 'collaborator', 'observer')),
        status TEXT NOT NULL DEFAULT 'invited',
        pre_revocation_status TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_at TEXT,
        last_login_at TEXT
      );
    `);

    const legacyUsers = loadLegacyUsers(db, userColNames);

    const insertUser = db.prepare(`
      INSERT INTO users_v2 (id, email, handle, role, status, pre_revocation_status, revoked_at, created_at, accepted_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const user of legacyUsers) {
      insertUser.run(
        crypto.randomUUID(),
        user.email,
        user.handle ?? null,
        user.role,
        user.status,
        user.pre_revocation_status ?? null,
        user.revoked_at ?? null,
        user.created_at ?? new Date().toISOString(),
        user.accepted_at ?? null,
        user.last_login_at ?? null
      );
    }

    db.exec(`
      ALTER TABLE users RENAME TO users_legacy;
      ALTER TABLE users_v2 RENAME TO users;
    `);
  }

  if (!hasColumn('users', 'pre_revocation_status')) {
    db.exec(`ALTER TABLE users ADD COLUMN pre_revocation_status TEXT;`);
  }

  if (!hasColumn('users', 'revoked_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN revoked_at TEXT;`);
  }

  // Jobs table: execution policy metadata
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  const jobColNames = new Set(jobCols.map((c) => c.name));

  if (!jobColNames.has('requested_by_email')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN requested_by_email TEXT;`);
  }

  if (!jobColNames.has('requested_by_user_id')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN requested_by_user_id TEXT;`);
  }

  if (!jobColNames.has('effective_mode')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN effective_mode TEXT;`);
  }

  if (!jobColNames.has('effective_profile')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN effective_profile TEXT;`);
  }

  if (!jobColNames.has('waiting_request_id')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN waiting_request_id INTEGER REFERENCES job_input_requests(id);`);
  }

  if (!jobColNames.has('last_resumed_at')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN last_resumed_at TEXT;`);
  }

  if (!jobColNames.has('resume_count')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;`);
  }

  if (tableExists('login_tokens') && !hasColumn('login_tokens', 'user_id')) {
    db.exec(`ALTER TABLE login_tokens ADD COLUMN user_id TEXT;`);
  }

  if (tableExists('sessions') && !hasColumn('sessions', 'user_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT;`);
  }

  if (tableExists('permissions') && !hasColumn('permissions', 'user_id')) {
    db.exec(`ALTER TABLE permissions ADD COLUMN user_id TEXT;`);
  }

  if (tableExists('usage_log') && !hasColumn('usage_log', 'user_id')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN user_id TEXT;`);
  }

  // Migrate legacy 'user' role to 'collaborator'
  db.exec(`UPDATE users SET role = 'collaborator' WHERE role = 'user';`);

  // Fail closed on legacy/accidental role values that are no longer product roles.
  db.exec(`UPDATE users SET role = 'observer' WHERE role NOT IN ('owner', 'collaborator', 'observer');`);

  // Artifact tables
  if (!tableExists('artifacts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY,
        topic_id INTEGER NOT NULL REFERENCES topics(id),
        artifact_class TEXT NOT NULL CHECK (artifact_class IN ('document')),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        canonical_source TEXT NOT NULL DEFAULT 'db',
        current_version_id INTEGER,
        promoted_repo_path TEXT,
        promoted_commit_sha TEXT,
        created_by_agent TEXT,
        created_by_user_id TEXT,
        created_by_user_email TEXT,
        created_by_job_id INTEGER REFERENCES jobs(id),
        created_from_message_id INTEGER REFERENCES messages(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  if (!tableExists('artifact_versions')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id INTEGER PRIMARY KEY,
        artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
        version INTEGER NOT NULL,
        content_type TEXT NOT NULL CHECK (content_type = 'text/markdown'),
        body TEXT NOT NULL,
        summary TEXT,
        created_by_agent TEXT,
        created_by_user_id TEXT,
        created_by_user_email TEXT,
        created_by_job_id INTEGER REFERENCES jobs(id),
        source_message_id INTEGER REFERENCES messages(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (artifact_id, version)
      );
    `);
  }

  if (!tableExists('message_artifacts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_artifacts (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
        artifact_version_id INTEGER NOT NULL REFERENCES artifact_versions(id),
        relation TEXT NOT NULL,
        PRIMARY KEY (message_id, artifact_id, artifact_version_id)
      );
    `);
  }

  if (tableExists('artifacts') && !hasColumn('artifacts', 'created_by_user_id')) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN created_by_user_id TEXT;`);
  }

  if (tableExists('artifact_versions') && !hasColumn('artifact_versions', 'created_by_user_id')) {
    db.exec(`ALTER TABLE artifact_versions ADD COLUMN created_by_user_id TEXT;`);
  }

  if (!tableExists('job_input_requests')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_input_requests (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        topic_id INTEGER NOT NULL REFERENCES topics(id),
        requested_by_agent TEXT NOT NULL,
        requested_by_message_id INTEGER REFERENCES messages(id),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
        request_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('confirm', 'single_select', 'multi_select', 'short_text', 'long_text')),
        prompt TEXT NOT NULL,
        form_json TEXT NOT NULL,
        response_json TEXT,
        answered_by_user_id TEXT REFERENCES users(id),
        answered_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_input_requests_pending_per_job
      ON job_input_requests (job_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_job_input_requests_topic_status
      ON job_input_requests (topic_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_job_input_requests_job
      ON job_input_requests (job_id, created_at DESC);
  `);

  repairTablesReferencingLegacyUsers(db);
  backfillUserIds(db, tableExists, hasColumn);

  const messageColNames = tableExists('messages')
    ? new Set((db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name))
    : new Set<string>();
  const topicSearchColNames = tableExists('topics')
    ? new Set((db.prepare("PRAGMA table_info(topics)").all() as { name: string }[]).map((c) => c.name))
    : new Set<string>();
  const hasMessagesSearchShape = ['id', 'body', 'author_name'].every((name) => messageColNames.has(name));
  const hasTopicsSearchShape = ['id', 'name'].every((name) => topicSearchColNames.has(name));

  if (hasMessagesSearchShape) {
    ensureMessagesFts(db, tableExists('messages_fts'));
  }

  if (hasTopicsSearchShape) {
    ensureTopicsFts(db, tableExists('topics_fts'));
  }
}

const USER_FK_REPAIR_BATCH_TABLES = [
  'login_tokens',
  'sessions',
  'permissions',
  'usage_log',
  'jobs',
  'artifacts',
  'artifact_versions',
  'message_artifacts',
  'job_input_requests',
];

function repairTablesReferencingLegacyUsers(db: DatabaseType): void {
  const badTables = (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name <> 'users_legacy'
      AND sql IS NOT NULL
      AND (sql LIKE '%users_legacy%' OR sql LIKE '%__legacy_rebuild__%')
    `).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => USER_FK_REPAIR_BATCH_TABLES.includes(name));

  if (badTables.length === 0) {
    return;
  }

  const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) !== 0;
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  const txn = db.transaction(() => {
    const tablesToRebuild = USER_FK_REPAIR_BATCH_TABLES.filter((tableName) => tableExists(db, tableName));
    const oldColumnsByTable = new Map<string, string[]>();

    for (const tableName of tablesToRebuild) {
      const tempName = `__legacy_rebuild__${tableName}`;
      oldColumnsByTable.set(tableName, getColumnNames(db, tableName));
      db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} RENAME TO ${quoteIdentifier(tempName)};`);
    }

    db.exec(SCHEMA);

    for (const tableName of tablesToRebuild) {
      const tempName = `__legacy_rebuild__${tableName}`;
      const oldColumns = oldColumnsByTable.get(tableName) ?? [];
      const newColumns = new Set(getColumnNames(db, tableName));
      const commonColumns = oldColumns.filter((column) => newColumns.has(column));
      if (commonColumns.length === 0) {
        throw new Error(`Cannot rebuild ${tableName}: no shared columns with canonical schema`);
      }

      const columnList = commonColumns.map(quoteIdentifier).join(', ');
      db.exec(`
        INSERT INTO ${quoteIdentifier(tableName)} (${columnList})
        SELECT ${columnList}
        FROM ${quoteIdentifier(tempName)};
      `);
    }

    for (const tableName of tablesToRebuild) {
      const tempName = `__legacy_rebuild__${tableName}`;
      db.exec(`DROP TABLE ${quoteIdentifier(tempName)};`);
    }

    // Re-run schema after dropping legacy temp tables so skipped IF NOT EXISTS indexes are recreated.
    db.exec(SCHEMA);
  });

  try {
    txn();
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }

  const mismatches = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name <> 'users_legacy'
      AND sql IS NOT NULL
      AND (sql LIKE '%users_legacy%' OR sql LIKE '%__legacy_rebuild__%')
  `).all() as Array<{ name: string }>;

  if (mismatches.length > 0) {
    throw new Error(`Legacy user foreign keys still present after repair: ${mismatches.map((row) => row.name).join(', ')}`);
  }

  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; parent: string }>;
  if (foreignKeyIssues.length > 0) {
    throw new Error(`Foreign key check failed after repair: ${foreignKeyIssues.map((row) => `${row.table}->${row.parent}`).join(', ')}`);
  }
}

function loadLegacyUsers(
  db: DatabaseType,
  userColNames: Set<string>
): Array<Record<string, any>> {
  if (!userColNames.has('email')) {
    throw new Error('Legacy users table is missing required column: email');
  }

  const orderBy = userColNames.has('created_at') ? 'created_at, email' : 'email';
  const rows = db.prepare(`SELECT * FROM users ORDER BY ${orderBy}`).all() as Array<Record<string, any>>;

  return rows.map((row) => {
    const handle = userColNames.has('handle') ? row.handle ?? null : null;
    const status = userColNames.has('status')
      ? row.status
      : (handle ? 'active' : 'invited');

    return {
      email: row.email,
      handle,
      role: normalizeLegacyRole(userColNames.has('role') ? row.role : undefined),
      status,
      pre_revocation_status: userColNames.has('pre_revocation_status') ? row.pre_revocation_status ?? null : null,
      revoked_at: userColNames.has('revoked_at') ? row.revoked_at ?? null : null,
      created_at: userColNames.has('created_at') ? row.created_at ?? new Date().toISOString() : new Date().toISOString(),
      accepted_at: userColNames.has('accepted_at') ? row.accepted_at ?? null : null,
      last_login_at: userColNames.has('last_login_at') ? row.last_login_at ?? null : null,
    };
  });
}

function normalizeLegacyRole(role: unknown): 'owner' | 'collaborator' | 'observer' {
  if (role === 'owner' || role === 'collaborator' || role === 'observer') {
    return role;
  }
  if (role === 'user') {
    return 'collaborator';
  }
  return 'observer';
}

function getColumnNames(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function tableExists(db: DatabaseType, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(name));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function backfillUserIds(
  db: DatabaseType,
  tableExists: (name: string) => boolean,
  hasColumn: (table: string, column: string) => boolean
): void {
  const emailToUserId = new Map<string, string>();
  const users = db.prepare('SELECT id, email FROM users').all() as Array<{ id: string; email: string }>;
  for (const user of users) {
    emailToUserId.set(user.email, user.id);
  }

  if (tableExists('login_tokens') && hasColumn('login_tokens', 'user_id')) {
    const update = db.prepare('UPDATE login_tokens SET user_id = ? WHERE token = ?');
    const rows = db.prepare('SELECT token, email, user_id FROM login_tokens').all() as Array<{ token: string; email: string; user_id: string | null }>;
    for (const row of rows) {
      if (row.user_id) continue;
      const userId = emailToUserId.get(row.email);
      if (userId) update.run(userId, row.token);
    }
  }

  if (tableExists('sessions') && hasColumn('sessions', 'user_id')) {
    const update = db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, email, user_id FROM sessions').all() as Array<{ id: string; email: string; user_id: string | null }>;
    for (const row of rows) {
      if (row.user_id) continue;
      const userId = emailToUserId.get(row.email);
      if (userId) update.run(userId, row.id);
    }
  }

  if (tableExists('jobs') && hasColumn('jobs', 'requested_by_user_id')) {
    const update = db.prepare('UPDATE jobs SET requested_by_user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, requested_by_email, requested_by_user_id FROM jobs').all() as Array<{ id: number; requested_by_email: string | null; requested_by_user_id: string | null }>;
    for (const row of rows) {
      if (row.requested_by_user_id || !row.requested_by_email) continue;
      const userId = emailToUserId.get(row.requested_by_email);
      if (userId) update.run(userId, row.id);
    }
  }

  if (tableExists('permissions') && hasColumn('permissions', 'user_id')) {
    const update = db.prepare('UPDATE permissions SET user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, email, user_id FROM permissions').all() as Array<{ id: number; email: string; user_id: string | null }>;
    for (const row of rows) {
      if (row.user_id) continue;
      const userId = emailToUserId.get(row.email);
      if (userId) update.run(userId, row.id);
    }
  }

  if (tableExists('usage_log') && hasColumn('usage_log', 'user_id')) {
    const update = db.prepare('UPDATE usage_log SET user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, user_email, user_id FROM usage_log').all() as Array<{ id: number; user_email: string | null; user_id: string | null }>;
    for (const row of rows) {
      if (row.user_id || !row.user_email) continue;
      const userId = emailToUserId.get(row.user_email);
      if (userId) update.run(userId, row.id);
    }
  }

  if (tableExists('artifacts') && hasColumn('artifacts', 'created_by_user_id')) {
    const update = db.prepare('UPDATE artifacts SET created_by_user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, created_by_user_email, created_by_user_id FROM artifacts').all() as Array<{ id: number; created_by_user_email: string | null; created_by_user_id: string | null }>;
    for (const row of rows) {
      if (row.created_by_user_id || !row.created_by_user_email) continue;
      const userId = emailToUserId.get(row.created_by_user_email);
      if (userId) update.run(userId, row.id);
    }
  }

  if (tableExists('artifact_versions') && hasColumn('artifact_versions', 'created_by_user_id')) {
    const update = db.prepare('UPDATE artifact_versions SET created_by_user_id = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, created_by_user_email, created_by_user_id FROM artifact_versions').all() as Array<{ id: number; created_by_user_email: string | null; created_by_user_id: string | null }>;
    for (const row of rows) {
      if (row.created_by_user_id || !row.created_by_user_email) continue;
      const userId = emailToUserId.get(row.created_by_user_email);
      if (userId) update.run(userId, row.id);
    }
  }
}

function ensureMessagesFts(db: DatabaseType, alreadyExists: boolean): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(body, author_name, content='messages', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body, author_name)
      VALUES (new.id, new.body, new.author_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body, author_name)
      VALUES ('delete', old.id, old.body, old.author_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body, author_name)
      VALUES ('delete', old.id, old.body, old.author_name);
      INSERT INTO messages_fts(rowid, body, author_name)
      VALUES (new.id, new.body, new.author_name);
    END;
  `);

  if (!alreadyExists) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');");
  }
}

function ensureTopicsFts(db: DatabaseType, alreadyExists: boolean): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts
    USING fts5(name, content='topics', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS topics_fts_ai AFTER INSERT ON topics BEGIN
      INSERT INTO topics_fts(rowid, name)
      VALUES (new.id, new.name);
    END;

    CREATE TRIGGER IF NOT EXISTS topics_fts_ad AFTER DELETE ON topics BEGIN
      INSERT INTO topics_fts(topics_fts, rowid, name)
      VALUES ('delete', old.id, old.name);
    END;

    CREATE TRIGGER IF NOT EXISTS topics_fts_au AFTER UPDATE OF name ON topics BEGIN
      INSERT INTO topics_fts(topics_fts, rowid, name)
      VALUES ('delete', old.id, old.name);
      INSERT INTO topics_fts(rowid, name)
      VALUES (new.id, new.name);
    END;
  `);

  if (!alreadyExists) {
    db.exec("INSERT INTO topics_fts(topics_fts) VALUES ('rebuild');");
  }
}
