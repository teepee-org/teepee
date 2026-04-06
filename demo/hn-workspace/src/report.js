const fs = require('fs');
const path = require('path');

const DEFAULT_DATASET = path.join(__dirname, '..', 'data', 'tickets.json');

function loadTickets(filePath = DEFAULT_DATASET) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeTicket(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    severity: ticket.severity,
    owner: ticket.owner,
    status: ticket.status,
    openedDaysAgo: ticket.openedDaysAgo,
    tags: Array.isArray(ticket.tags) ? ticket.tags : [],
  };
}

function filterTickets(tickets, options = {}) {
  const { owner, status = 'open', staleDays = 7 } = options;

  return tickets
    .map(normalizeTicket)
    .filter((ticket) => status === 'all' || !status || ticket.status === status)
    .filter((ticket) => !owner || ticket.owner === owner)
    .map((ticket) => ({
      ...ticket,
      stale: ticket.openedDaysAgo >= staleDays,
    }));
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] ?? '(unknown)';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function collectHotTags(tickets, limit = 5) {
  const counts = new Map();

  for (const ticket of tickets) {
    for (const tag of ticket.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function summarizeTickets(tickets, options = {}) {
  const activeTickets = filterTickets(tickets, options);
  const staleTickets = activeTickets.filter((ticket) => ticket.stale);

  return {
    totalOpen: activeTickets.length,
    staleCount: staleTickets.length,
    bySeverity: countBy(activeTickets, 'severity'),
    byOwner: countBy(activeTickets, 'owner'),
    hotTags: collectHotTags(activeTickets),
    staleTickets,
  };
}

function formatTextReport(summary, options = {}) {
  const staleDays = options.staleDays ?? 7;
  const lines = [
    'Support Queue Summary',
    `Open tickets: ${summary.totalOpen}`,
    `Stale tickets (${staleDays}+ days): ${summary.staleCount}`,
    '',
    'By severity:',
  ];

  for (const [severity, count] of Object.entries(summary.bySeverity)) {
    lines.push(`- ${severity}: ${count}`);
  }

  lines.push('');
  lines.push('By owner:');
  for (const [owner, count] of Object.entries(summary.byOwner)) {
    lines.push(`- ${owner}: ${count}`);
  }

  lines.push('');
  lines.push('Hot tags:');
  for (const item of summary.hotTags) {
    lines.push(`- ${item.tag}: ${item.count}`);
  }

  lines.push('');
  lines.push('Oldest stale tickets:');
  for (const ticket of summary.staleTickets.slice(0, 3)) {
    lines.push(`- ${ticket.id} (${ticket.owner}) ${ticket.openedDaysAgo}d - ${ticket.title}`);
  }

  return lines.join('\n');
}

function formatMarkdownReport(summary, options = {}) {
  const staleDays = options.staleDays ?? 7;
  const lines = [
    '# Support Queue Summary',
    '',
    `- Open tickets: ${summary.totalOpen}`,
    `- Stale tickets (${staleDays}+ days): ${summary.staleCount}`,
    '',
    '## By severity',
  ];

  const severityEntries = Object.entries(summary.bySeverity);
  if (severityEntries.length === 0) {
    lines.push('- None');
  } else {
    for (const [severity, count] of severityEntries) {
      lines.push(`- ${severity}: ${count}`);
    }
  }

  lines.push('');
  lines.push('## By owner');
  const ownerEntries = Object.entries(summary.byOwner);
  if (ownerEntries.length === 0) {
    lines.push('- None');
  } else {
    for (const [owner, count] of ownerEntries) {
      lines.push(`- ${owner}: ${count}`);
    }
  }

  lines.push('');
  lines.push('## Hot tags');
  if (summary.hotTags.length === 0) {
    lines.push('- None');
  } else {
    for (const item of summary.hotTags) {
      lines.push(`- ${item.tag}: ${item.count}`);
    }
  }

  lines.push('');
  lines.push('## Oldest stale tickets');
  const staleSlice = summary.staleTickets.slice(0, 3);
  if (staleSlice.length === 0) {
    lines.push('- None');
  } else {
    for (const ticket of staleSlice) {
      lines.push(`- **${ticket.id}** (\`${ticket.owner}\`, ${ticket.openedDaysAgo}d): ${ticket.title}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  DEFAULT_DATASET,
  loadTickets,
  filterTickets,
  summarizeTickets,
  formatTextReport,
  formatMarkdownReport,
};
