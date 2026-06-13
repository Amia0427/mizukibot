#!/usr/bin/env node

const {
  buildChatDefaultMemoryLeakDiagnostic,
  formatChatDefaultMemoryLeakDiagnostic,
  parseArgs
} = require('../utils/chatDefaultMemoryLeakDiagnostics');

function printHelp() {
  console.log([
    'Usage: node scripts/diagnose-chat-default-memory-leak.js [options]',
    '',
    'Read-only scan for ordinary chat/default requests that injected memory blocks without explicit recall intent.',
    '',
    'Inputs:',
    '  --data-dir <path>        Data directory, default data/.',
    '  --model-calls <path>     model-calls.ndjson path override.',
    '  --request-trace <path>   request-trace.ndjson path override.',
    '  --observability <path>   memory-recall-observability.ndjson path override.',
    '  --max-lines <n>          Recent lines to read from each file, default 50000.',
    '  --since <duration>       Keep rows inside a recent window, e.g. 6h, 30m, 2d.',
    '',
    'Output:',
    '  --limit <n>              Max violations to print, default 50.',
    '  --json                   Machine-readable JSON.',
    '  --text                   Text summary, default.',
    '  --exclude-admin          Exclude admin user_role model calls from candidates.'
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const report = buildChatDefaultMemoryLeakDiagnostic(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatChatDefaultMemoryLeakDiagnostic(report));
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
