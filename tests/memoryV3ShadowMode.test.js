'use strict';

const assert = require('assert');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

createMemoryV3TempEnv('mizuki-memory-v3-shadow-');
process.env.MEMORY_STORAGE_MODE = 'v3_shadow';
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'false';

const { addMemoryItemsBatch } = require('../utils/vectorMemory');

addMemoryItemsBatch([{
  id: 'legacy-shadow-only',
  userId: 'u_shadow',
  type: 'fact',
  text: '用户喜欢柚子茶',
  status: 'active',
  confidence: 1
}]);

const { queryMemory, writeMemoryBatch } = require('../utils/memory-v3');

module.exports = (async () => {
  await writeMemoryBatch([{
    id: 'v3-shadow-only',
    userId: 'u_shadow',
    type: 'fact',
    text: '用户喜欢柚子茶和准确的文件引用',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1
  }], {
    materialize: true,
    scheduleEmbeddingBackfill: false
  });

  const result = await queryMemory({
    userId: 'u_shadow',
    query: '柚子茶',
    topK: 8
  });

  assert.deepStrictEqual(result.results.map((item) => item.id), ['v3-shadow-only']);
  assert.strictEqual(result.storageMode, 'v3_shadow');
  assert.strictEqual(result.diagnostics.storageShadow.ok, true);
  assert.deepStrictEqual(result.diagnostics.storageShadow.legacyOnlyIds, ['legacy-shadow-only']);
  assert.deepStrictEqual(result.diagnostics.storageShadow.v3OnlyIds, ['v3-shadow-only']);
  assert.strictEqual(result.diagnostics.storageShadow.overlapCount, 0);

  console.log('memoryV3ShadowMode.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
