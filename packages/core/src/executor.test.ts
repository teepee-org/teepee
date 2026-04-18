import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildContext, runAgent } from './executor.js';
import { openDb, createTopic, insertMessage } from './db.js';

describe('runAgent', () => {
  it('runs the provider in the project working directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-executor-test-'));
    const scriptPath = path.join(tmpDir, 'write-file.js');
    const outputPath = path.join(tmpDir, 'agent-output.txt');

    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const outputPath = path.join(process.cwd(), 'agent-output.txt');",
        "fs.writeFileSync(outputPath, 'edited-by-agent');",
        "console.log('done');",
      ].join('\n')
    );

    const result = await runAgent('node write-file.js', 'context', 5000, tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('edited-by-agent');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts the final agent message from codex json output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-codex-json-test-'));
    const scriptPath = path.join(tmpDir, 'codex');

    fs.writeFileSync(
      scriptPath,
      [
        '#!/bin/sh',
        "echo 'Reading prompt from stdin...'",
        "echo '{\"type\":\"thread.started\",\"thread_id\":\"123\"}'",
        "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final clean answer\"}}'",
        "echo '{\"type\":\"turn.completed\",\"usage\":{\"output_tokens\":5}}'",
      ].join('\n')
    );
    fs.chmodSync(scriptPath, 0o755);

    const originalPath = process.env.PATH || '';
    process.env.PATH = `${tmpDir}:${originalPath}`;

    const result = await runAgent('codex exec', 'context', 5000, tmpDir, undefined);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('final clean answer');

    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not stream raw codex json events to onChunk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-codex-stream-test-'));
    const scriptPath = path.join(tmpDir, 'codex');

    fs.writeFileSync(
      scriptPath,
      [
        '#!/bin/sh',
        "echo '{\"type\":\"thread.started\",\"thread_id\":\"123\"}'",
        "echo '{\"type\":\"turn.started\"}'",
        "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final clean answer\"}}'",
      ].join('\n')
    );
    fs.chmodSync(scriptPath, 0o755);

    const originalPath = process.env.PATH || '';
    process.env.PATH = `${tmpDir}:${originalPath}`;

    const chunks: string[] = [];
    const result = await runAgent('codex exec', 'context', 5000, tmpDir, (chunk) => {
      chunks.push(chunk);
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('final clean answer');
    expect(chunks).toEqual([]);

    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves quoted arguments when parsing provider commands', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-command-parse-test-'));

    const result = await runAgent(
      'node -e "console.log(process.argv.slice(1).join(\'|\'))" "foo bar" baz',
      'context',
      5000,
      tmpDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('foo bar|baz');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not run db_only as an executor mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-db-only-executor-test-'));
    const result = await runAgent({
      command: 'node -e "console.log(\'should not run\')"',
      context: 'context',
      timeoutMs: 5000,
      cwd: tmpDir,
      executionMode: 'db_only',
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unknown execution mode 'db_only'");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('buildContext', () => {
  it('includes agent-isolation and quoted-mention instructions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-context-test-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');
    const db = openDb(dbPath);
    const topicId = createTopic(db, 'test');
    const messageId = insertMessage(db, topicId, 'user', 'owner', '@coder presentati');

    const config = {
      version: 1 as const,
      mode: 'private' as const,
      teepee: {
        name: 'test',
        language: 'it',
        demo: {
          enabled: false,
          topic_name: 'hn-live-demo',
          hotkey: 'F1',
          delay_ms: 1200,
        },
      },
      server: {
        trust_proxy: false,
        cors_allowed_origins: [],
        auth_rate_limit_window_seconds: 60,
        auth_rate_limit_max_requests: 20,
      },
      providers: {
        claude: { command: 'echo' },
      },
      agents: {
        coder: { provider: 'claude' },
      },
      limits: {
        max_agents_per_message: 5,
        max_jobs_per_user_per_minute: 10,
        max_chain_depth: 2,
        max_total_jobs_per_chain: 10,
      },
      roles: { owner: { coder: 'readwrite' as const }, collaborator: { coder: 'readwrite' as const }, observer: {} },
      security: {
        sandbox: { runner: 'bubblewrap' as const, empty_home: true, private_tmp: true, forward_env: [] },
      },
    };

    const context = buildContext(db, 'coder', topicId, messageId, 'it', config, tmpDir);

    expect(context).toContain('You are @coder. Respond only as @coder.');
    expect(context).toContain('Do not speak on behalf of other agents');
    expect(context).toContain('Never tag yourself with @your-name');
    expect(context).toContain('Do not delegate, hand off, or tag another agent unless the user explicitly asked you to do that');
    expect(context).toContain('Never claim that you created files, changed code, ran commands, or completed deliverables unless you actually did so');
    expect(context).toContain('If you changed files but could not verify them, say the edits were applied but remain unverified');
    expect(context).toContain('Do not claim blocked steps succeeded or were verified');
    expect(context).toContain('quote the mention like "@agent"');
    expect(context).toContain('Tag another agent with @agent only when you want that agent to take action');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('personalizes the current message by removing active agent tags from the current line', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-context-personalized-test-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');
    const db = openDb(dbPath);
    const topicId = createTopic(db, 'test');
    const messageId = insertMessage(
      db,
      topicId,
      'user',
      'owner',
      '@coder @reviewer @architect cosa ne pensate di "@reviewer"?'
    );

    const config = {
      version: 1 as const,
      mode: 'private' as const,
      teepee: {
        name: 'test',
        language: 'it',
        demo: {
          enabled: false,
          topic_name: 'hn-live-demo',
          hotkey: 'F1',
          delay_ms: 1200,
        },
      },
      server: {
        trust_proxy: false,
        cors_allowed_origins: [],
        auth_rate_limit_window_seconds: 60,
        auth_rate_limit_max_requests: 20,
      },
      providers: {
        claude: { command: 'echo' },
      },
      agents: {
        coder: { provider: 'claude' },
      },
      limits: {
        max_agents_per_message: 5,
        max_jobs_per_user_per_minute: 10,
        max_chain_depth: 2,
        max_total_jobs_per_chain: 10,
      },
      roles: { owner: { coder: 'readwrite' as const }, collaborator: { coder: 'readwrite' as const }, observer: {} },
      security: {
        sandbox: { runner: 'bubblewrap' as const, empty_home: true, private_tmp: true, forward_env: [] },
      },
    };

    const context = buildContext(db, 'coder', topicId, messageId, 'it', config, tmpDir);
    const currentSection = context.split('[current]\n')[1] || '';

    expect(currentSection).toBe('owner> cosa ne pensate di "@reviewer"?');
    expect(currentSection).not.toContain('@coder ');
    expect(currentSection).not.toContain('@architect');
    expect(currentSection).toContain('"@reviewer"');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes the lazy artifact read workflow when artifact access is enabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-context-artifact-test-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');
    const db = openDb(dbPath);
    const topicId = createTopic(db, 'test');
    const messageId = insertMessage(db, topicId, 'user', 'owner', '@coder aggiorna il documento');

    const config = {
      version: 1 as const,
      mode: 'private' as const,
      teepee: {
        name: 'test',
        language: 'it',
        demo: {
          enabled: false,
          topic_name: 'hn-live-demo',
          hotkey: 'F1',
          delay_ms: 1200,
        },
      },
      server: {
        trust_proxy: false,
        cors_allowed_origins: [],
        auth_rate_limit_window_seconds: 60,
        auth_rate_limit_max_requests: 20,
      },
      providers: {
        claude: { command: 'echo' },
      },
      agents: {
        coder: { provider: 'claude' },
      },
      limits: {
        max_agents_per_message: 5,
        max_jobs_per_user_per_minute: 10,
        max_chain_depth: 2,
        max_total_jobs_per_chain: 10,
      },
      roles: { owner: { coder: 'readwrite' as const }, collaborator: { coder: 'readwrite' as const }, observer: {} },
      security: {
        sandbox: { runner: 'bubblewrap' as const, empty_home: true, private_tmp: true, forward_env: [] },
      },
    };

    const context = buildContext(db, 'coder', topicId, messageId, 'it', config, tmpDir, [
      { id: 2, kind: 'report', title: "Che cos'e Teepee", current_version: 2 },
    ]);

    expect(context).toContain('[artifacts/v2]');
    expect(context).toContain('Do not inspect source code, databases, or other files in the project to verify these formats');
    expect(context).toContain('Artifact-ops root key is "operations" (not "ops"). Artifacts root key is "documents".');
    expect(context).toContain('"op_id": "read-head", "op": "read-current", "artifact_id": 42');
    expect(context).toContain('"op": "update", "artifact_id": 42, "base_version": "current"');
    expect(context).toContain('"op": "create", "kind": "spec"');
    expect(context).toContain('"op": "edit"');
    expect(context).toContain('"edits": [');
    expect(context).toContain('For any existing document change, use this workflow: read-current on the target artifact');
    expect(context).toContain('Prefer base_version: "current" after read-current');
    expect(context).toContain("STRONGLY PREFER 'edit' for small targeted changes");

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shrinks topic history when building artifact-focused context', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-context-artifact-focus-test-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');
    const db = openDb(dbPath);
    const topicId = createTopic(db, 'test');
    insertMessage(db, topicId, 'user', 'owner', 'intro');
    insertMessage(db, topicId, 'agent', 'architect', 'A'.repeat(3000));
    const triggerMessageId = insertMessage(
      db,
      topicId,
      'user',
      'owner',
      '@architect aggiorna l\'artifact "Doc" aggiungendo solo un link'
    );

    const config = {
      version: 1 as const,
      mode: 'private' as const,
      teepee: {
        name: 'test',
        language: 'it',
        demo: {
          enabled: false,
          topic_name: 'hn-live-demo',
          hotkey: 'F1',
          delay_ms: 1200,
        },
      },
      server: {
        trust_proxy: false,
        cors_allowed_origins: [],
        auth_rate_limit_window_seconds: 60,
        auth_rate_limit_max_requests: 20,
      },
      providers: {
        claude: { command: 'echo' },
      },
      agents: {
        architect: { provider: 'claude' },
      },
      limits: {
        max_agents_per_message: 5,
        max_jobs_per_user_per_minute: 10,
        max_chain_depth: 2,
        max_total_jobs_per_chain: 10,
      },
      roles: { owner: { architect: 'readwrite' as const }, collaborator: { architect: 'readwrite' as const }, observer: {} },
      security: {
        sandbox: { runner: 'bubblewrap' as const, empty_home: true, private_tmp: true, forward_env: [] },
      },
    };

    const context = buildContext(
      db,
      'architect',
      topicId,
      triggerMessageId,
      'it',
      config,
      tmpDir,
      [{ id: 10, kind: 'spec', title: 'Doc', current_version: 1 }]
    );

    expect(context).toContain('[… truncated ');
    expect(context).not.toContain('A'.repeat(2000));
    expect(context).toContain('@architect aggiorna l\'artifact "Doc" aggiungendo solo un link');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
