const { loadTickets, summarizeTickets, formatTextReport, formatMarkdownReport } = require('./report');

const VALID_FORMATS = ['text', 'markdown', 'json'];
const VALID_STATUSES = ['open', 'closed', 'all'];

function parseArgs(argv) {
  const options = {
    owner: null,
    staleDays: 7,
    format: 'text',
    status: 'open',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--owner') {
      options.owner = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--stale-days') {
      options.staleDays = Number(argv[i + 1] || 7);
      i += 1;
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--format') {
      options.format = argv[i + 1];
      i += 1;
    } else if (arg === '--status') {
      options.status = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (!VALID_FORMATS.includes(options.format)) {
    process.stderr.write(`Error: unsupported format "${options.format}". Valid formats: ${VALID_FORMATS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  if (!VALID_STATUSES.includes(options.status)) {
    process.stderr.write(`Error: unsupported status "${options.status}". Valid statuses: ${VALID_STATUSES.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const tickets = loadTickets();
  const summary = summarizeTickets(tickets, options);

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else if (options.format === 'markdown') {
    process.stdout.write(`${formatMarkdownReport(summary, options)}\n`);
  } else {
    process.stdout.write(`${formatTextReport(summary, options)}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  main,
};
