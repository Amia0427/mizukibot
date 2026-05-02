const {
  buildRuntimeStatusDiagnostic,
  buildRuntimeStatusText
} = require('../utils/runtimeStatusDiagnostics');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2).filter((item) => String(item || '').startsWith('--')));
  return {
    json: flags.has('--json'),
    text: flags.has('--text')
  };
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildRuntimeStatusDiagnostic();
  if (args.text && !args.json) {
    console.log(buildRuntimeStatusText(report));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  main
};
