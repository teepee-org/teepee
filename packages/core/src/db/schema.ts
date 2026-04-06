export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    handle TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'invited',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at TEXT,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
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
    archived INTEGER NOT NULL DEFAULT 0,
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
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY,
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
`;
