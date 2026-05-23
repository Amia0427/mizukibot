#!/usr/bin/env node

const { importMemoryFile } = require('../utils/memory-v3/fileImport');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    userId: '',
    groupId: '',
    filePath: '',
    category: '',
    tags: [],
    dryRun: false,
    noMaterialize: false,
    noEmbeddingBackfill: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--user' || item === '--user-id') {
      args.userId = normalizeText(argv[index + 1]);
      index += 1;
    } else if (item === '--group' || item === '--group-id') {
      args.groupId = normalizeText(argv[index + 1]);
      index += 1;
    } else if (item === '--file') {
      args.filePath = normalizeText(argv[index + 1]);
      index += 1;
    } else if (item === '--category') {
      args.category = normalizeText(argv[index + 1]);
      index += 1;
    } else if (item === '--tags') {
      args.tags = normalizeText(argv[index + 1]).split(',').map(normalizeText).filter(Boolean);
      index += 1;
    } else if (item === '--dry-run') {
      args.dryRun = true;
    } else if (item === '--no-materialize') {
      args.noMaterialize = true;
    } else if (item === '--no-embedding-backfill') {
      args.noEmbeddingBackfill = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  if (!args.filePath || (!args.userId && !args.groupId)) {
    console.error('Usage: node scripts/import-memory-file.js --user <id> --file <path> [--category name] [--tags a,b] [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const result = await importMemoryFile({
    userId: args.userId,
    groupId: args.groupId,
    filePath: args.filePath,
    category: args.category,
    tags: args.tags,
    dryRun: args.dryRun,
    materialize: !args.noMaterialize,
    scheduleEmbeddingBackfill: !args.noEmbeddingBackfill
  });
  console.log(JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    file: result.file,
    chunks: result.chunks,
    created: result.created || 0,
    updated: result.updated || 0,
    materialized: Boolean(result.materialize?.ok),
    materializeDeferred: Boolean(result.materialize?.deferred)
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[import-memory-file] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs
};
