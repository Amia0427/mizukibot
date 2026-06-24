#!/usr/bin/env node

const {
  buildMainModelRetryDuplicateDiagnostic,
  formatMainModelRetryDuplicateDiagnostic,
  parseArgs
} = require('../utils/mainModelRetryDuplicateDiagnostics');

function printHelp() {
  console.log([
    'Usage: node scripts/diagnose-main-model-retry-duplicates.js [options]',
    '',
    'Read-only scan for suspicious duplicate main-model calls caused by 408 retries.',
    '',
    'Inputs:',
    '  --data-dir <path>        Data directory, default data/.',
    '  --model-calls <path>     model-calls.ndjson path override.',
    '  --request-trace <path>   request-trace.ndjson path override.',
    '  --max-lines <n>          Recent lines to read from each file, default 50000.',
    '  --since <duration>       Keep rows inside a recent window, e.g. 6h, 30m, 2d.',
    '  --around <iso-time>      Keep rows near one timestamp, e.g. 2026-06-24T00:47:59+08:00.',
    '  --window <duration>      Around window size, default 10m when --around is set.',
    '',
    'Output:',
    '  --limit <n>              Max samples to print, default 20.',
    '  --admin-only             Only return admin-role/admin-user samples.',
    '  --json                   Machine-readable JSON.',
    '  --text                   Text summary, default.'
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const report = buildMainModelRetryDuplicateDiagnostic(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMainModelRetryDuplicateDiagnostic(report));
  }
  return report;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs
};
