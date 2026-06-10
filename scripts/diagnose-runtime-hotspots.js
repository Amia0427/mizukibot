const {
  buildRuntimeHotspotsDiagnostic,
  buildRuntimeHotspotsText
} = require('../utils/runtimeHotspotsDiagnostics');

function parseWindowMs(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2] || 'm';
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'h') return Math.round(amount * 60 * 60 * 1000);
  return Math.round(amount * 60 * 1000);
}

function parseArgs(argv = []) {
  const args = argv.slice(2);
  const parsed = {
    json: false,
    text: false,
    windowMs: 0
  };
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
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildRuntimeHotspotsDiagnostic({
    windowMs: args.windowMs || undefined
  });
  if ((args.text || !args.json) && !args.json) {
    console.log(buildRuntimeHotspotsText(report));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseWindowMs,
  main
};
