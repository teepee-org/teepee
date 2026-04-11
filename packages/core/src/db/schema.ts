export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent TEXT,
    ip TEXT
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT,
    parent_topic_id INTEGER REFERENCES topics(id),
    sort_order REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    author_type TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    agent_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (message_id, agent_name)
);

CREATE TABLE IF NOT EXISTS invocation_batches (
    id INTEGER PRIMARY KEY,
    trigger_message_id INTEGER NOT NULL REFERENCES messages(id),
    chain_root_batch_id INTEGER,
    chain_depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES invocation_batches(id),
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    output_message_id INTEGER REFERENCES messages(id),
    error TEXT,
    requested_by_user_id TEXT REFERENCES users(id),
    requested_by_email TEXT,
    effective_mode TEXT,
    effective_profile TEXT,
    waiting_request_id INTEGER REFERENCES job_input_requests(id),
    last_resumed_at TEXT,
    resume_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    email TEXT NOT NULL,
    topic_id INTEGER,
    target_agent TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    UNIQUE (email, topic_id, target_agent)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_global
    ON permissions (email, target_agent) WHERE topic_id IS NULL;

CREATE TABLE IF NOT EXISTS topic_aliases (
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    alias TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    PRIMARY KEY (topic_id, alias)
);

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    user_email TEXT,
    agent_name TEXT NOT NULL,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    topic_id INTEGER,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
    created_by_user_id TEXT REFERENCES users(id),
    created_by_user_email TEXT,
    created_by_job_id INTEGER REFERENCES jobs(id),
    created_from_message_id INTEGER REFERENCES messages(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifact_versions (
    id INTEGER PRIMARY KEY,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
    version INTEGER NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type = 'text/markdown'),
    body TEXT NOT NULL,
    summary TEXT,
    created_by_agent TEXT,
    created_by_user_id TEXT REFERENCES users(id),
    created_by_user_email TEXT,
    created_by_job_id INTEGER REFERENCES jobs(id),
    source_message_id INTEGER REFERENCES messages(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS message_artifacts (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
    artifact_version_id INTEGER NOT NULL REFERENCES artifact_versions(id),
    relation TEXT NOT NULL,
    PRIMARY KEY (message_id, artifact_id, artifact_version_id)
);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_input_requests_pending_per_job
    ON job_input_requests (job_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_job_input_requests_topic_status
    ON job_input_requests (topic_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_job_input_requests_job
    ON job_input_requests (job_id, created_at DESC);

`;
