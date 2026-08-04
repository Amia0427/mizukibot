'use strict';

const assert = require('assert');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

createMemoryV3TempEnv('mizuki-memory-v3-legacy-compat-');
process.env.MEMORY_STORAGE_MODE = 'legacy_compat';

const config = require('../config');
const { writeMemoryBatch } = require('../utils/memory-v3');
const { getMemoryItems } = require('../utils/vectorMemory');

module.exports = (async () => {
  const mirrored = await writeMemoryBatch([{
    id: 'legacy-compat-mirrored',
    userId: 'u_legacy_compat',
    type: 'fact',
    text: '兼容模式写入仍可被旧主读召回',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1
  }], { scheduleEmbeddingBackfill: false });
  assert.strictEqual(mirrored.ok, true);
  assert.deepStrictEqual(mirrored.legacyMirror.ids, ['legacy-compat-mirrored']);
  assert.ok(getMemoryItems('u_legacy_compat').some((item) => item.id === 'legacy-compat-mirrored'));

  config.MEMORY_STORAGE_MODE = 'v3_only';
  const v3Only = await writeMemoryBatch([{
    id: 'v3-only-not-mirrored',
    userId: 'u_legacy_compat',
    type: 'fact',
    text: 'V3 only 不写旧存储',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1
  }], { scheduleEmbeddingBackfill: false });
  assert.strictEqual(v3Only.ok, true);
  assert.strictEqual(v3Only.legacyMirror.skipped, true);
  assert.ok(!getMemoryItems('u_legacy_compat').some((item) => item.id === 'v3-only-not-mirrored'));

  console.log('memoryV3LegacyCompatMode.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
