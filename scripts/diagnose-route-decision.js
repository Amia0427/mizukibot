#!/usr/bin/env node

const {
  buildRouteDecisionDiagnostic,
  formatRouteDecisionDiagnostic,
  parseArgs
} = require('../utils/routeDecisionDiagnostics');

function printHelp() {
  console.log([
    'Usage: node scripts/diagnose-route-decision.js [options]',
    '',
    'Read-only explanation for why a request used normal fast reply, direct reply, planner/tool route, or fallback.',
    '',
    'Inputs:',
    '  --request-id <id[,id]>  Explain recorded request-trace rows.',
    '  --text <message>        Predict from a test input without calling models/tools.',
    '  --user-id <id>          User id for --text mode.',
    '  --chat-type <private|group>',
    '  --group-id <id>',
    '  --image-url <url>       Simulate image input for --text mode.',
    '  --allowed-tools a,b     Simulate tool allowlist for --text mode.',
    '  --admin                 Treat --text user as admin.',
    '',
    'Trace options:',
    '  --trace-file <path>     Default data/request-trace.ndjson.',
    '  --data-dir <path>       Default data/.',
    '  --max-lines <n>         Recent trace lines to read, default 50000.',
    '  --since <duration>      Keep recent rows only, e.g. 30m, 6h, 2d.',
    '  --limit <n>             Max requests to print, default 20.',
    '',
    'Output:',
    '  --json                  Machine-readable JSON.'
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const report = buildRouteDecisionDiagnostic(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatRouteDecisionDiagnostic(report));
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
