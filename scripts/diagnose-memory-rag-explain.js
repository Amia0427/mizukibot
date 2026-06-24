#!/usr/bin/env node

function normalizeText(value = '') {
  return String(value || '').trim();
}

function readOption(argv = [], index = 0) {
  return normalizeText(argv[index + 1]);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    userId: '',
    query: '',
    sessionKey: '',
    groupId: '',
    facet: '',
    source: 'all',
    topK: 8,
    stageLimit: 8,
    maxChars: 180,
    dataDir: '',
    json: true
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const item = normalizeText(argv[index]);
    if (!item) continue;
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    if (item === '--user-id' || item === '--userId' || item === '--user') {
      out.userId = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--user-id=')) {
      out.userId = item.slice('--user-id='.length).trim();
    } else if (item.startsWith('--userId=')) {
      out.userId = item.slice('--userId='.length).trim();
    } else if (item === '--query' || item === '--text' || item === '--question') {
      out.query = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--query=')) {
      out.query = item.slice('--query='.length).trim();
    } else if (item.startsWith('--text=')) {
      out.query = item.slice('--text='.length).trim();
    } else if (item.startsWith('--question=')) {
      out.query = item.slice('--question='.length).trim();
    } else if (item === '--session-key' || item === '--sessionKey') {
      out.sessionKey = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--session-key=')) {
      out.sessionKey = item.slice('--session-key='.length).trim();
    } else if (item.startsWith('--sessionKey=')) {
      out.sessionKey = item.slice('--sessionKey='.length).trim();
    } else if (item === '--group-id' || item === '--groupId') {
      out.groupId = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--group-id=')) {
      out.groupId = item.slice('--group-id='.length).trim();
    } else if (item.startsWith('--groupId=')) {
      out.groupId = item.slice('--groupId='.length).trim();
    } else if (item === '--facet') {
      out.facet = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--facet=')) {
      out.facet = item.slice('--facet='.length).trim();
    } else if (item === '--source') {
      out.source = readOption(argv, index) || 'all';
      index += 1;
    } else if (item.startsWith('--source=')) {
      out.source = item.slice('--source='.length).trim() || 'all';
    } else if (item === '--top-k' || item === '--topK') {
      out.topK = Number(readOption(argv, index)) || out.topK;
      index += 1;
    } else if (item.startsWith('--top-k=')) {
      out.topK = Number(item.slice('--top-k='.length)) || out.topK;
    } else if (item.startsWith('--topK=')) {
      out.topK = Number(item.slice('--topK='.length)) || out.topK;
    } else if (item === '--stage-limit') {
      out.stageLimit = Number(readOption(argv, index)) || out.stageLimit;
      index += 1;
    } else if (item.startsWith('--stage-limit=')) {
      out.stageLimit = Number(item.slice('--stage-limit='.length)) || out.stageLimit;
    } else if (item === '--max-chars') {
      out.maxChars = Number(readOption(argv, index)) || out.maxChars;
      index += 1;
    } else if (item.startsWith('--max-chars=')) {
      out.maxChars = Number(item.slice('--max-chars='.length)) || out.maxChars;
    } else if (item === '--data-dir' || item === '--dataDir') {
      out.dataDir = readOption(argv, index);
      index += 1;
    } else if (item.startsWith('--data-dir=')) {
      out.dataDir = item.slice('--data-dir='.length).trim();
    } else if (item.startsWith('--dataDir=')) {
      out.dataDir = item.slice('--dataDir='.length).trim();
    } else if (item === '--json') {
      out.json = true;
    }
  }

  if (!out.query && positional.length > 0) {
    out.query = positional.join(' ').trim();
  }
  return out;
}

async function run(options = parseArgs()) {
  if (options.dataDir) {
    process.env.DATA_DIR = options.dataDir;
  }
  const {
    buildMemoryV3RagExplainDiagnostic
  } = require('../utils/memory-v3/ragExplainDiagnostic');
  const report = await buildMemoryV3RagExplainDiagnostic(options, options);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  run().then((report) => {
    process.exitCode = report.ok === false ? 1 : 0;
  }).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  run
};
