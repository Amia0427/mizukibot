const {
  buildMainBotRestartDiagnostic,
  buildMainBotRestartText
} = require('../utils/mainBotRestartDiagnostics');

function parsePositiveInt(value = '', fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    text: false,
    tailLines: 30,
    maxArchiveLogs: 2,
    maxDaemonEvents: 16
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--json') parsed.json = true;
    else if (item === '--text') parsed.text = true;
    else if (item === '--tail-lines') {
      parsed.tailLines = parsePositiveInt(args[i + 1], parsed.tailLines);
      i += 1;
    } else if (item.startsWith('--tail-lines=')) {
      parsed.tailLines = parsePositiveInt(item.slice('--tail-lines='.length), parsed.tailLines);
    } else if (item === '--max-archive-logs') {
      parsed.maxArchiveLogs = parsePositiveInt(args[i + 1], parsed.maxArchiveLogs);
      i += 1;
    } else if (item.startsWith('--max-archive-logs=')) {
      parsed.maxArchiveLogs = parsePositiveInt(item.slice('--max-archive-logs='.length), parsed.maxArchiveLogs);
    } else if (item === '--max-daemon-events') {
      parsed.maxDaemonEvents = parsePositiveInt(args[i + 1], parsed.maxDaemonEvents);
      i += 1;
    } else if (item.startsWith('--max-daemon-events=')) {
      parsed.maxDaemonEvents = parsePositiveInt(item.slice('--max-daemon-events='.length), parsed.maxDaemonEvents);
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildMainBotRestartDiagnostic({
    tailLines: args.tailLines,
    maxArchiveLogs: args.maxArchiveLogs,
    maxDaemonEvents: args.maxDaemonEvents
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(buildMainBotRestartText(report));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  main
};
