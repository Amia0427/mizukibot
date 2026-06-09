const {
  buildRequestTracePreflightDiagnostic,
  formatRequestTracePreflightDiagnostic,
  parseArgs
} = require('../utils/requestTracePreflightDiagnostics');

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const report = buildRequestTracePreflightDiagnostic(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(formatRequestTracePreflightDiagnostic(report));
  return report;
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs
};
