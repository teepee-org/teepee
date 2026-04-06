const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadTickets,
  filterTickets,
  summarizeTickets,
  formatTextReport,
  formatMarkdownReport,
} = require('../src/report');
const { parseArgs } = require('../src/index');

test('filterTickets defaults to open tickets only', () => {
  const tickets = loadTickets();
  const filtered = filterTickets(tickets);

  assert.equal(filtered.length, 6);
  assert.ok(filtered.every((ticket) => ticket.status === 'open'));
});

test('summarizeTickets groups open tickets by severity and owner', () => {
  const tickets = loadTickets();
  const summary = summarizeTickets(tickets, { staleDays: 7 });

  assert.equal(summary.totalOpen, 6);
  assert.equal(summary.staleCount, 3);
  assert.equal(summary.bySeverity.critical, 1);
  assert.equal(summary.bySeverity.high, 2);
  assert.equal(summary.byOwner.maya, 3);
});

test('formatTextReport renders human-readable sections', () => {
  const tickets = loadTickets();
  const summary = summarizeTickets(tickets, { staleDays: 7 });
  const report = formatTextReport(summary, { staleDays: 7 });

  assert.match(report, /Support Queue Summary/);
  assert.match(report, /By severity:/);
  assert.match(report, /Oldest stale tickets:/);
  assert.match(report, /SUP-105/);
});

test('formatMarkdownReport renders markdown headings and bold ticket IDs', () => {
  const tickets = loadTickets();
  const summary = summarizeTickets(tickets, { staleDays: 7 });
  const report = formatMarkdownReport(summary, { staleDays: 7 });

  assert.match(report, /^# Support Queue Summary/);
  assert.match(report, /## By severity/);
  assert.match(report, /## Oldest stale tickets/);
  assert.match(report, /\*\*SUP-105\*\*/);
});

test('parseArgs accepts owner, stale days, and format flags', () => {
  const args = parseArgs(['--owner', 'maya', '--stale-days', '10', '--format', 'markdown']);

  assert.deepEqual(args, {
    owner: 'maya',
    staleDays: 10,
    format: 'markdown',
    status: 'open',
  });
});

test('parseArgs treats --json as format json alias', () => {
  const args = parseArgs(['--json']);

  assert.deepEqual(args, {
    owner: null,
    staleDays: 7,
    format: 'json',
    status: 'open',
  });
});

test('parseArgs defaults to text format', () => {
  const args = parseArgs([]);

  assert.equal(args.format, 'text');
});

test('parseArgs accepts --status flag', () => {
  const args = parseArgs(['--status', 'closed']);

  assert.deepEqual(args, {
    owner: null,
    staleDays: 7,
    format: 'text',
    status: 'closed',
  });
});

test('parseArgs defaults status to open', () => {
  const args = parseArgs([]);

  assert.equal(args.status, 'open');
});

test('filterTickets with status closed returns only closed tickets', () => {
  const tickets = loadTickets();
  const filtered = filterTickets(tickets, { status: 'closed' });

  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((ticket) => ticket.status === 'closed'));
});

test('filterTickets with status all returns all tickets', () => {
  const tickets = loadTickets();
  const all = filterTickets(tickets, { status: 'all' });
  const open = filterTickets(tickets, { status: 'open' });
  const closed = filterTickets(tickets, { status: 'closed' });

  assert.equal(all.length, open.length + closed.length);
});
