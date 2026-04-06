#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');

function usage() {
  process.stderr.write(
    'Usage: node scripts/clone-demo-topic.js --source <topic-id-or-name> --target <new-topic-name>\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    source: null,
    target: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      args.source = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--target') {
      args.target = argv[i + 1] || null;
      i += 1;
    }
  }

  if (!args.source || !args.target) usage();
  return args;
}

function toMillis(sqliteDate) {
  return new Date(sqliteDate.replace(' ', 'T') + 'Z').getTime();
}

function fromMillis(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function main(argv = process.argv.slice(2)) {
  const { source, target } = parseArgs(argv);
  const dbPath = path.join(__dirname, '..', '.teepee', 'db.sqlite');
  const db = new Database(dbPath);

  const sourceTopic = /^\d+$/.test(source)
    ? db.prepare('SELECT id, name, language, archived, created_at FROM topics WHERE id = ?').get(Number(source))
    : db.prepare('SELECT id, name, language, archived, created_at FROM topics WHERE name = ?').get(source);

  if (!sourceTopic) {
    process.stderr.write(`Source topic not found: ${source}\n`);
    process.exit(1);
  }

  const existingTarget = db.prepare('SELECT id FROM topics WHERE name = ?').get(target);
  if (existingTarget) {
    process.stderr.write(`Target topic already exists: ${target}\n`);
    process.exit(1);
  }

  const messages = db
    .prepare(
      'SELECT author_type, author_name, body, created_at FROM messages WHERE topic_id = ? ORDER BY id'
    )
    .all(sourceTopic.id);

  if (messages.length === 0) {
    process.stderr.write(`Source topic has no messages: ${source}\n`);
    process.exit(1);
  }

  const insertTopic = db.prepare(
    'INSERT INTO topics (name, language, archived, created_at) VALUES (?, ?, ?, ?)'
  );
  const insertMessage = db.prepare(
    'INSERT INTO messages (topic_id, author_type, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const now = Date.now();
  const firstMessageMs = toMillis(messages[0].created_at);

  const tx = db.transaction(() => {
    const topicResult = insertTopic.run(target, sourceTopic.language, sourceTopic.archived, fromMillis(now));
    const newTopicId = Number(topicResult.lastInsertRowid);

    for (const message of messages) {
      const offsetMs = Math.max(0, toMillis(message.created_at) - firstMessageMs);
      insertMessage.run(
        newTopicId,
        message.author_type,
        message.author_name,
        message.body,
        fromMillis(now + offsetMs)
      );
    }

    return newTopicId;
  });

  const newTopicId = tx();
  db.close();

  process.stdout.write(
    `Cloned topic ${sourceTopic.id} (${sourceTopic.name}) to topic ${newTopicId} (${target}).\n`
  );
}

main();
