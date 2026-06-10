const {
  buildMainReplyLagDiagnostic,
  buildMainReplyLagDiagnosticText,
  parseWindowMs
} = require('../utils/mainReplyLagDiagnostics');

function parseArgs(argv = []) {
  const args = argv.slice(2);
  const parsed = {
    json: false,
    text: false,
    windowMs: 0,
    includeProvider: true,
    provider: '',
    providerScenarios: 'main_reply'
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (!item) continue;
    if (item === '--json') parsed.json = true;
    else if (item === '--text') parsed.text = true;
    else if (item === '--provider-diagnostic') parsed.includeProvider = true;
    else if (item === '--no-provider-diagnostic') parsed.includeProvider = false;
    else if (item === '--window' || item === '--since') {
      parsed.windowMs = parseWindowMs(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--window=')) {
      parsed.windowMs = parseWindowMs(item.slice('--window='.length));
    } else if (item.startsWith('--since=')) {
      parsed.windowMs = parseWindowMs(item.slice('--since='.length));
    } else if (item === '--provider') {
      parsed.provider = String(args[i + 1] || '').trim();
      parsed.includeProvider = true;
      i += 1;
    } else if (item.startsWith('--provider=')) {
      parsed.provider = item.slice('--provider='.length).trim();
      parsed.includeProvider = true;
    } else if (item === '--scenario' || item === '--scenarios') {
      parsed.providerScenarios = String(args[i + 1] || '').trim() || parsed.providerScenarios;
      i += 1;
    } else if (item.startsWith('--scenario=')) {
      parsed.providerScenarios = item.slice('--scenario='.length).trim() || parsed.providerScenarios;
    } else if (item.startsWith('--scenarios=')) {
      parsed.providerScenarios = item.slice('--scenarios='.length).trim() || parsed.providerScenarios;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await buildMainReplyLagDiagnostic({
    windowMs: args.windowMs || undefined,
    includeProvider: args.includeProvider,
    provider: args.provider,
    providerScenarios: args.providerScenarios
  });
  if (args.json && !args.text) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(buildMainReplyLagDiagnosticText(report));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  main
};
