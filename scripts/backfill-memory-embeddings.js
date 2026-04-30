const path = require('path');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const {
  getMemoryItems,
  rebuildMemoryIndex
} = require('../utils/vectorMemory');
const {
  embedMemoryItems,
  isEmbeddingFresh
} = require('../utils/memorySemanticIndex');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const items = getMemoryItems();
  const result = await embedMemoryItems(items);

  if (!dryRun && result.embedded > 0) {
    rebuildMemoryIndex({ version: 3, items });
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    attempted: result.attempted,
    embedded: result.embedded,
    fresh: items.filter((item) => isEmbeddingFresh(item)).length,
    cwd: process.cwd(),
    script: path.basename(__filename)
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-memory-embeddings] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = { main };
