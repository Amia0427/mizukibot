const {
  buildMainReplyPromptAssemblyDiagnostic,
  parseArgs
} = require('../utils/mainReplyPromptAssemblyDiagnostics');

async function run(options = parseArgs(process.argv)) {
  const input = options.requestId
    ? { requestId: options.requestId }
    : options.text;
  const report = await buildMainReplyPromptAssemblyDiagnostic(input, options);
  console.log(JSON.stringify(report, null, 2));
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
