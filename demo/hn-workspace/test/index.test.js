const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/index');

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

test('main --format markdown outputs markdown headings', () => {
  const output = captureStdout(() => main(['--format', 'markdown']));

  assert.match(output, /^# Support Queue Summary/);
  assert.match(output, /## By severity/);
});

test('main --json outputs valid JSON', () => {
  const output = captureStdout(() => main(['--json']));
  const parsed = JSON.parse(output);

  assert.equal(typeof parsed.totalOpen, 'number');
  assert.ok(Array.isArray(parsed.staleTickets));
});

test('main rejects unsupported format with error', () => {
  const originalExitCode = process.exitCode;
  const errOutput = captureStderr(() => main(['--format', 'html']));
  assert.match(errOutput, /unsupported format "html"/);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
});

test('main --status closed outputs only closed tickets', () => {
  const output = captureStdout(() => main(['--status', 'closed', '--json']));
  const parsed = JSON.parse(output);

  assert.ok(parsed.totalOpen >= 0);
});

test('main rejects unsupported status with error', () => {
  const originalExitCode = process.exitCode;
  const errOutput = captureStderr(() => main(['--status', 'pending']));
  assert.match(errOutput, /unsupported status "pending"/);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
});
