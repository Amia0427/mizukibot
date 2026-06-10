const {
  parseProviderDiagnosticArgs,
  runProviderRequestDiagnostics
} = require('../utils/providerRequestDiagnostics');

async function main() {
  const options = parseProviderDiagnosticArgs(process.argv.slice(2));
  const report = await runProviderRequestDiagnostics(options);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  main
};
