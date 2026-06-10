const {
  materializeMemoryV3Views,
  migrateLegacyMemoryToV3
} = require('../utils/memory-v3/migration');

const args = new Set(process.argv.slice(2));
const shouldImportLegacy = args.has('--import-legacy') || args.has('--force-import-legacy');

const task = shouldImportLegacy
  ? migrateLegacyMemoryToV3({ forceImport: args.has('--force-import-legacy') })
  : Promise.resolve(materializeMemoryV3Views({
    force: true,
    source: 'migrate_memory_v3_cli'
  }));

task.then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error('[migrate-memory-v3] failed:', error?.stack || error?.message || error);
  process.exit(1);
});
