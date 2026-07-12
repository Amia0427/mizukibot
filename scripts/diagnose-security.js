const {
  collectSecurityDiagnostics,
  formatSecurityWarning
} = require('../utils/securityDiagnostics');

function printTextReport(report) {
  console.log(`Security diagnostics: ${report.status.toUpperCase()}`);
  console.log(`Summary: ok=${report.summary.ok} warn=${report.summary.warn} error=${report.summary.error}`);
  for (const finding of report.findings) {
    const prefix = finding.level.toUpperCase().padEnd(5, ' ');
    if (finding.level === 'ok') {
      console.log(`[${prefix}] ${finding.title}: ${finding.detail}`);
    } else {
      console.log(`[${prefix}] ${formatSecurityWarning(finding)}`);
    }
  }
}

function main(options = {}) {
  const argv = options.argv || process.argv;
  const stdout = options.stdout || process.stdout;
  const collectDiagnostics = options.collectDiagnostics || collectSecurityDiagnostics;
  const json = argv.includes('--json');
  const report = collectDiagnostics();
  if (json) {
    stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printTextReport(report);
  }
  return report.status === 'error' ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, printTextReport };
