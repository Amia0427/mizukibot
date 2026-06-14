const {
  buildMainReplyPromptAssemblyDiagnostic,
  parseArgs
} = require('../utils/mainReplyPromptAssemblyDiagnostics');

async function run(options = parseArgs(process.argv)) {
  const input = options.requestId
    ? { requestId: options.requestId }
    : options.text;
  const report = await buildMainReplyPromptAssemblyDiagnostic(input, options);
  console.log(JSON.stringify({
    schemaVersion: 'live_state_dynamic_entrypoint_v1',
    checkedAt: report.checkedAt,
    mode: report.mode,
    exactPromptRebuilt: report.exactPromptRebuilt,
    requestId: report.requestId || '',
    input: report.input || null,
    files: report.files || null,
    summary: {
      foundModelCall: report.summary?.foundModelCall,
      foundPromptObservation: report.summary?.foundPromptObservation,
      liveStateDynamicHit: report.summary?.liveStateDynamicHit ?? report.liveStateDynamic?.hit,
      finalTokenEstimate: report.liveStateDynamic?.finalTokenEstimate ?? null,
      promptPosition: report.liveStateDynamic?.promptPosition || null
    },
    liveStateDynamic: report.liveStateDynamic || null
  }, null, 2));
}

if (require.main === module) {
  run().then(() => {
    process.exit(0);
  }).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  run
};
