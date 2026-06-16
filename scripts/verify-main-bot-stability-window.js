const {
  DEFAULT_END,
  DEFAULT_EXPECTED_PID,
  DEFAULT_START,
  buildMainBotStabilityWindowReport,
  buildMainBotStabilityWindowText
} = require('../utils/mainBotStabilityWindow');

function parsePositiveInt(value = '', fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readArgValue(args, index) {
  return String(args[index + 1] || '').trim();
}

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    start: DEFAULT_START,
    end: DEFAULT_END,
    expectedPid: DEFAULT_EXPECTED_PID
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--json') parsed.json = true;
    else if (item === '--start') {
      parsed.start = readArgValue(args, i) || parsed.start;
      i += 1;
    } else if (item.startsWith('--start=')) {
      parsed.start = item.slice('--start='.length) || parsed.start;
    } else if (item === '--end') {
      parsed.end = readArgValue(args, i) || parsed.end;
      i += 1;
    } else if (item.startsWith('--end=')) {
      parsed.end = item.slice('--end='.length) || parsed.end;
    } else if (item === '--expected-pid') {
      parsed.expectedPid = parsePositiveInt(readArgValue(args, i), parsed.expectedPid);
      i += 1;
    } else if (item.startsWith('--expected-pid=')) {
      parsed.expectedPid = parsePositiveInt(item.slice('--expected-pid='.length), parsed.expectedPid);
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildMainBotStabilityWindowReport(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(buildMainBotStabilityWindowText(report));
  }
  if (report.status !== 'pass') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  main
};
