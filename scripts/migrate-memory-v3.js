const { migrateLegacyMemoryToV3 } = require('../utils/memory-v3/migration');

migrateLegacyMemoryToV3().then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error('[migrate-memory-v3] failed:', error?.stack || error?.message || error);
  process.exit(1);
});
