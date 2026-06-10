const assert = require('assert');
const {
  LANCEDB_SELECT_COLUMNS,
  buildMemoryFilter
} = require('../utils/lancedbMemoryStore/rows');

const lancedbStore = require('../utils/lancedbMemoryStore/index');

assert.ok(LANCEDB_SELECT_COLUMNS.includes('category'));
assert.ok(LANCEDB_SELECT_COLUMNS.includes('tagsText'));
assert.ok(LANCEDB_SELECT_COLUMNS.includes('intent'));
assert.ok(LANCEDB_SELECT_COLUMNS.includes('privacyLevel'));

const filter = buildMemoryFilter({
  userId: 'u_meta',
  category: 'preference',
  memoryIntent: 'personalization',
  privacyLevel: 'private'
});
assert.ok(filter.sql.includes("category = 'preference'"));
assert.ok(filter.sql.includes("intent = 'personalization'"));
assert.ok(filter.sql.includes("privacyLevel = 'private'"));
assert.strictEqual(filter.category, 'preference');
assert.strictEqual(filter.intentFilter, 'personalization');
assert.strictEqual(filter.privacyLevel, 'private');

assert.strictEqual(typeof lancedbStore.searchMemoryVectors, 'function');

console.log('lancedbMetadataCompatibility.test.js passed');
