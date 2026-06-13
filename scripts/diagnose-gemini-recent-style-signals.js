#!/usr/bin/env node

const {
  buildGeminiRecentStyleSignalDiagnostic,
  buildGeminiRecentStyleSignalText
} = require('../utils/geminiRecentStyleSignalDiagnostics');

function readArgValue(argv, index) {
  const item = String(argv[index] || '');
  const eq = item.indexOf('=');
  if (eq >= 0) return { value: item.slice(eq + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    text: false,
    help: false,
    storePath: '',
    lookbackRecords: undefined,
    maxRecords: undefined,
    maxAgeMs: undefined,
    limit: undefined,
    scopeKey: ''
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] || '').trim();
    const key = item.split('=')[0];
    if (key === '--help' || key === '-h') {
      options.help = true;
    } else if (key === '--json') {
      options.json = true;
    } else if (key === '--text') {
      options.text = true;
    } else if (key === '--file' || key === '--store') {
      const { value, consumed } = readArgValue(argv, i);
      options.storePath = String(value || '');
      i += consumed;
    } else if (key === '--lookback-records' || key === '--lookback') {
      const { value, consumed } = readArgValue(argv, i);
      options.lookbackRecords = Math.max(1, Math.floor(Number(value || 0) || 0));
      i += consumed;
    } else if (key === '--max-records') {
      const { value, consumed } = readArgValue(argv, i);
      options.maxRecords = Math.max(1, Math.floor(Number(value || 0) || 0));
      i += consumed;
    } else if (key === '--max-age-ms') {
      const { value, consumed } = readArgValue(argv, i);
      options.maxAgeMs = Math.max(0, Math.floor(Number(value || 0) || 0));
      i += consumed;
    } else if (key === '--max-age-days') {
      const { value, consumed } = readArgValue(argv, i);
      const days = Math.max(0, Number(value || 0) || 0);
      options.maxAgeMs = Math.floor(days * 24 * 60 * 60 * 1000);
      i += consumed;
    } else if (key === '--limit') {
      const { value, consumed } = readArgValue(argv, i);
      options.limit = Math.max(1, Math.floor(Number(value || 0) || 0));
      i += consumed;
    } else if (key === '--scope-key') {
      const { value, consumed } = readArgValue(argv, i);
      options.scopeKey = String(value || '');
      i += consumed;
    }
  }

  if (!options.text && !options.json) options.text = true;
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/diagnose-gemini-recent-style-signals.js [options]',
    '',
    'Read data/gemini-recent-style-signals.json and summarize recent Gemini style signals.',
    '',
    'Options:',
    '  --text                    Human-readable output, default.',
    '  --json                    Machine-readable JSON report.',
    '  --file <path>             Read a specific store file instead of data/gemini-recent-style-signals.json.',
    '  --lookback-records <n>    Recent records considered for guard ranking, default 18.',
    '  --limit <n>               Rows per signal group, default 12.',
    '  --scope-key <key>         Prioritize records from one scope before global recent records.',
    '  --max-age-days <n>        Recent store age window, default 7.'
  ].join('\n'));
}

function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const report = buildGeminiRecentStyleSignalDiagnostic(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(buildGeminiRecentStyleSignalText(report));
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs
};
