import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { SCHEMA } from './schema.js';
import { expirePendingJobInputRequests } from '../user-input/db.js';

describe('runMigrations', () => {
  it('maps unknown legacy roles to observer', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE users (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY
      );
      INSERT INTO users (email, role) VALUES
        ('legacy@test.com', 'user'),
        ('bad@test.com', 'superadmin');
    `);

    runMigrations(db);

    const rows = db.prepare('SELECT email, role FROM users ORDER BY email').all() as Array<{ email: string; role: string }>;
    expect(rows).toEqual([
      { email: 'bad@test.com', role: 'observer' },
      { email: 'legacy@test.com', role: 'collaborator' },
    ]);

    db.close();
  });

  it('migrates minimal legacy users tables that do not have handle/status columns', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE users (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY
      );
      INSERT INTO users (email, role) VALUES ('legacy@test.com', 'collaborator');
    `);

    runMigrations(db);

    const row = db.prepare('SELECT id, email, handle, role, status FROM users WHERE email = ?').get('legacy@test.com') as {
      id: string;
      email: string;
      handle: string | null;
      role: string;
      status: string;
    };

    expect(row.id).toBeTruthy();
    expect(row.email).toBe('legacy@test.com');
    expect(row.handle).toBeNull();
    expect(row.role).toBe('collaborator');
    expect(row.status).toBe('invited');

    db.close();
  });

  it('backfills user_id into legacy auth and job tables', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE users (
        email TEXT PRIMARY KEY,
        handle TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        requested_by_email TEXT
      );
      CREATE TABLE login_tokens (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      INSERT INTO users (email, handle, role, status) VALUES ('owner@test.com', 'owner', 'owner', 'active');
      INSERT INTO jobs (id, requested_by_email) VALUES (1, 'owner@test.com');
      INSERT INTO login_tokens (token, email) VALUES ('tok', 'owner@test.com');
      INSERT INTO sessions (id, email, expires_at) VALUES ('sess', 'owner@test.com', '9999-01-01T00:00:00.000Z');
    `);

    runMigrations(db);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@test.com') as { id: string };
    const job = db.prepare('SELECT requested_by_user_id FROM jobs WHERE id = 1').get() as { requested_by_user_id: string | null };
    const token = db.prepare('SELECT user_id FROM login_tokens WHERE token = ?').get('tok') as { user_id: string | null };
    const session = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('sess') as { user_id: string | null };

    expect(job.requested_by_user_id).toBe(user.id);
    expect(token.user_id).toBe(user.id);
    expect(session.user_id).toBe(user.id);

    db.close();
  });

  it('repairs schema tables whose foreign keys were rewritten to users_legacy during user migration', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE users (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        topic_id INTEGER NOT NULL,
        author_type TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE invocation_batches (
        id INTEGER PRIMARY KEY,
        trigger_message_id INTEGER NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL,
        agent_name TEXT NOT NULL
      );
      INSERT INTO topics (id, sort_order) VALUES (1, 1);
      INSERT INTO users (email, role) VALUES ('owner@test.com', 'owner');
      INSERT INTO messages (id, topic_id, author_type, author_name, body) VALUES (1, 1, 'user', 'owner', 'hello');
      INSERT INTO invocation_batches (id, trigger_message_id) VALUES (1, 1);
      INSERT INTO jobs (id, batch_id, agent_name) VALUES (1, 1, 'architect');
    `);

    // Reproduce openDb() on a legacy database: schema first, then migrations.
    db.exec(SCHEMA);
    runMigrations(db);

    const leakedRefs = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name <> 'users_legacy'
        AND sql IS NOT NULL
        AND (sql LIKE '%users_legacy%' OR sql LIKE '%__legacy_rebuild__%')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(leakedRefs).toEqual([]);

    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    expect(foreignKeyIssues).toEqual([]);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@test.com') as { id: string };
    expect(() => db.prepare(`
      INSERT INTO job_input_requests (
        job_id, topic_id, requested_by_agent, requested_by_message_id, requested_by_user_id,
        status, request_key, title, kind, prompt, form_json
      ) VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      1,
      1,
      'architect',
      user.id,
      'doc_topic',
      'Scegli il topic',
      'single_select',
      'Quale doc vuoi?',
      JSON.stringify({
        request_key: 'doc_topic',
        title: 'Scegli il topic',
        kind: 'single_select',
        prompt: 'Quale doc vuoi?',
        required: true,
        allow_comment: false,
        options: [
          { id: 'documents', label: 'Gestione documenti' },
          { id: 'checkpoint', label: 'Gestione checkpoint' },
        ],
      }),
    )).not.toThrow();

    expect(() => db.prepare(`
      UPDATE jobs
      SET status = 'failed', waiting_request_id = NULL
      WHERE id = ?
    `).run(1)).not.toThrow();

    db.close();
  });

  it('repairs schema tables whose foreign keys were rewritten to __legacy_rebuild__ temp tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        topic_id INTEGER NOT NULL,
        author_type TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE invocation_batches (
        id INTEGER PRIMARY KEY,
        trigger_message_id INTEGER NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        waiting_request_id INTEGER REFERENCES job_input_requests(id)
      );
      CREATE TABLE job_input_requests (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        topic_id INTEGER NOT NULL REFERENCES topics(id),
        requested_by_agent TEXT NOT NULL,
        requested_by_message_id INTEGER REFERENCES messages(id),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        request_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        form_json TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO topics (id, sort_order) VALUES (1, 1);
      INSERT INTO users (id, email, role, status) VALUES ('usr_1', 'owner@test.com', 'owner', 'active');
      INSERT INTO messages (id, topic_id, author_type, author_name, body) VALUES (1, 1, 'user', 'owner', 'hello');
      INSERT INTO invocation_batches (id, trigger_message_id) VALUES (1, 1);
      INSERT INTO jobs (id, batch_id, agent_name, status, waiting_request_id) VALUES (1, 1, 'architect', 'waiting_input', 1);
      INSERT INTO job_input_requests (
        id, job_id, topic_id, requested_by_agent, requested_by_message_id, requested_by_user_id,
        status, request_key, title, kind, prompt, form_json, expires_at
      ) VALUES (
        1, 1, 1, 'architect', 1, 'usr_1',
        'pending', 'approval', 'Approval needed', 'confirm', 'Proceed?',
        '{"request_key":"approval","title":"Approval needed","kind":"confirm","prompt":"Proceed?","required":true,"allow_comment":false}',
        '2000-01-01T00:00:00.000Z'
      );
    `);

    db.exec('ALTER TABLE job_input_requests RENAME TO __legacy_rebuild__job_input_requests;');
    db.exec(`
      CREATE TABLE job_input_requests (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        topic_id INTEGER NOT NULL REFERENCES topics(id),
        requested_by_agent TEXT NOT NULL,
        requested_by_message_id INTEGER REFERENCES messages(id),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        request_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        form_json TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO job_input_requests (
        id, job_id, topic_id, requested_by_agent, requested_by_message_id, requested_by_user_id,
        status, request_key, title, kind, prompt, form_json, expires_at
      ) VALUES (
        1, 1, 1, 'architect', 1, 'usr_1',
        'pending', 'approval', 'Approval needed', 'confirm', 'Proceed?',
        '{"request_key":"approval","title":"Approval needed","kind":"confirm","prompt":"Proceed?","required":true,"allow_comment":false}',
        '2000-01-01T00:00:00.000Z'
      );
    `);
    db.exec('DROP TABLE __legacy_rebuild__job_input_requests;');

    runMigrations(db);

    const leakedRefs = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND sql IS NOT NULL
        AND (sql LIKE '%users_legacy%' OR sql LIKE '%__legacy_rebuild__%')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(leakedRefs).toEqual([]);

    expect(() => expirePendingJobInputRequests(db, '9999-01-01T00:00:00.000Z')).not.toThrow();

    db.close();
  });
});
