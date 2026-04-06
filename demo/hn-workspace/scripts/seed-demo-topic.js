#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function usage() {
  process.stderr.write(
    'Usage: node scripts/seed-demo-topic.js --seed <seed-json> --target <new-topic-name>\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    seed: null,
    target: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed') {
      args.seed = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--target') {
      args.target = argv[i + 1] || null;
      i += 1;
    }
  }

  if (!args.seed || !args.target) usage();
  return args;
}

function toMillis(sqliteDate) {
  return new Date(sqliteDate.replace(' ', 'T') + 'Z').getTime();
}

function fromMillis(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function main(argv = process.argv.slice(2)) {
  const { seed, target } = parseArgs(argv);
  const rootDir = path.join(__dirname, '..');
  const dbPath = path.join(rootDir, '.teepee', 'db.sqlite');

  if (!fs.existsSync(dbPath)) {
    process.stderr.write('Teepee database not found. Start Teepee once first so it creates .teepee/db.sqlite.\n');
    process.exit(1);
  }

  const seedPath = path.resolve(rootDir, seed);
  if (!fs.existsSync(seedPath)) {
    process.stderr.write(`Seed file not found: ${seedPath}\n`);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    process.stderr.write(`Seed file has no messages: ${seedPath}\n`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  const existingTarget = db.prepare('SELECT id FROM topics WHERE name = ?').get(target);
  if (existingTarget) {
    process.stderr.write(`Target topic already exists: ${target}\n`);
    process.exit(1);
  }

  const insertTopic = db.prepare(
    'INSERT INTO topics (name, language, archived, created_at) VALUES (?, ?, 0, ?)'
  );
  const insertMessage = db.prepare(
    'INSERT INTO messages (topic_id, author_type, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const now = Date.now();
  const firstMessageMs = toMillis(payload.messages[0].created_at);

  const tx = db.transaction(() => {
    const topicResult = insertTopic.run(target, payload.language ?? null, fromMillis(now));
    const newTopicId = Number(topicResult.lastInsertRowid);

    for (const message of payload.messages) {
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
    `Seeded topic ${newTopicId} (${target}) from ${path.relative(rootDir, seedPath)}.\n`
  );
}

main();
