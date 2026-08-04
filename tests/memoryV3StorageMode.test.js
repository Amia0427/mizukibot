'use strict';

const assert = require('assert');

process.env.MEMORY_STORAGE_MODE = '';
delete require.cache[require.resolve('../config')];
let config = require('../config');
assert.strictEqual(config.MEMORY_STORAGE_MODE, 'legacy_compat');

process.env.MEMORY_STORAGE_MODE = 'v3_shadow';
delete require.cache[require.resolve('../config')];
config = require('../config');
assert.strictEqual(config.MEMORY_STORAGE_MODE, 'v3_shadow');

process.env.MEMORY_STORAGE_MODE = 'unsupported';
delete require.cache[require.resolve('../config')];
config = require('../config');
assert.strictEqual(config.MEMORY_STORAGE_MODE, 'legacy_compat');

const {
  isLegacyMemoryReadable,
  isLegacyMemoryShadowEnabled,
  isLegacyMemoryWritable,
  resolveMemoryStorageMode
} = require('../utils/memory-v3/storageMode');

assert.strictEqual(resolveMemoryStorageMode('v3_only'), 'v3_only');
assert.strictEqual(resolveMemoryStorageMode('unsupported'), 'legacy_compat');
assert.strictEqual(isLegacyMemoryReadable('legacy_compat'), true);
assert.strictEqual(isLegacyMemoryShadowEnabled('legacy_compat'), false);
assert.strictEqual(isLegacyMemoryWritable('legacy_compat'), true);
assert.strictEqual(isLegacyMemoryReadable('v3_shadow'), true);
assert.strictEqual(isLegacyMemoryShadowEnabled('v3_shadow'), true);
assert.strictEqual(isLegacyMemoryWritable('v3_shadow'), false);
assert.strictEqual(isLegacyMemoryReadable('v3_only'), false);
assert.strictEqual(isLegacyMemoryShadowEnabled('v3_only'), false);
assert.strictEqual(isLegacyMemoryWritable('v3_only'), false);

console.log('memoryV3StorageMode.test.js passed');
