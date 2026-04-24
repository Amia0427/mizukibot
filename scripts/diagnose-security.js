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

function main() {
  const json = process.argv.includes('--json');
  const report = collectSecurityDiagnostics();
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  printTextReport(report);
}

if (require.main === module) {
  main();
}

module.exports = { printTextReport };
