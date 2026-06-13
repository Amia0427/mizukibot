const {
  rebuildLocalPromptRecallDb,
  getStatus
} = require('../utils/localPromptRecall');

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv.map((item) => String(item || '').trim()).filter(Boolean));
  const getValue = (name, fallback = '') => {
    const prefix = `${name}=`;
    const found = argv.find((item) => String(item || '').startsWith(prefix));
    return found ? String(found).slice(prefix.length) : fallback;
  };
  return {
    withEmbeddings: args.has('--embeddings') || args.has('--with-embeddings'),
    forceEmbedding: args.has('--force-embedding'),
    dbFile: getValue('--db-file', ''),
    statusOnly: args.has('--status'),
    json: args.has('--json')
  };
}

async function main() {
  const options = parseArgs();
  if (options.statusOnly) {
    const status = getStatus(options);
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.ok ? 0 : 1);
  }
  const result = await rebuildLocalPromptRecallDb({
    dbFile: options.dbFile,
    withEmbeddings: options.withEmbeddings,
    forceEmbedding: options.forceEmbedding
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`[local-prompt-recall] rebuilt ${result.count} rows (${result.examples} examples, ${result.modules} modules, embedded=${result.embedded})`);
    console.log(`[local-prompt-recall] db=${result.dbFile}`);
  } else {
    console.error(`[local-prompt-recall] failed: ${result.reason || 'unknown'} ${result.error || ''}`.trim());
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[local-prompt-recall] failed:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
