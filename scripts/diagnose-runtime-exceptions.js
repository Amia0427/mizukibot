const {
  buildRuntimeExceptionDiagnostic,
  buildRuntimeExceptionText,
  parseWindowMs
} = require('../utils/runtimeExceptionDiagnostics');

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    text: false,
    windowMs: 0,
    maxLines: 0
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--json') parsed.json = true;
    else if (item === '--text') parsed.text = true;
    else if (item === '--window' || item === '--since') {
      parsed.windowMs = parseWindowMs(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--window=')) {
      parsed.windowMs = parseWindowMs(item.slice('--window='.length));
    } else if (item.startsWith('--since=')) {
      parsed.windowMs = parseWindowMs(item.slice('--since='.length));
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
  const report = buildRuntimeExceptionDiagnostic({
    windowMs: args.windowMs || undefined,
    maxLines: args.maxLines || undefined
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(buildRuntimeExceptionText(report));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  main
};
