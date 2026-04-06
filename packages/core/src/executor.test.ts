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
});

describe('buildContext', () => {
  it('includes agent-isolation and quoted-mention instructions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teepee-context-test-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');
    const db = openDb(dbPath);
    const topicId = createTopic(db, 'test');
    const messageId = insertMessage(db, topicId, 'user', 'owner', '@coder presentati');

    const config = {
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
});
