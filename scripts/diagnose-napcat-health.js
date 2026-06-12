const {
  buildNapCatHealthDiagnostic,
  buildNapCatHealthText
} = require('../utils/napcatHealthDiagnostics');

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    text: false,
    maxEvents: 0,
    maxLines: 0
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--json') parsed.json = true;
    else if (item === '--text') parsed.text = true;
    else if (item === '--max-events') {
      parsed.maxEvents = Math.max(0, Math.floor(Number(args[i + 1]) || 0));
      i += 1;
    } else if (item.startsWith('--max-events=')) {
      parsed.maxEvents = Math.max(0, Math.floor(Number(item.slice('--max-events='.length)) || 0));
    } else if (item === '--max-lines') {
      parsed.maxLines = Math.max(0, Math.floor(Number(args[i + 1]) || 0));
      i += 1;
    } else if (item.startsWith('--max-lines=')) {
      parsed.maxLines = Math.max(0, Math.floor(Number(item.slice('--max-lines='.length)) || 0));
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildNapCatHealthDiagnostic({
    maxEvents: args.maxEvents || undefined,
    maxLines: args.maxLines || undefined
  });
  if (args.text && !args.json) {
    console.log(buildNapCatHealthText(report));
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
