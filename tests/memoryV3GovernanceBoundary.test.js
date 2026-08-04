'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMemoryV3TempEnv } = require('./memoryV3TestHarness');

const tempRoot = createMemoryV3TempEnv('mizuki-memory-v3-governance-boundary-');
process.env.MEMORY_STORAGE_MODE = 'v3_only';

const itemsFile = path.join(tempRoot, 'memory_items.json');
const original = JSON.stringify({
  version: 2,
  items: [{ id: 'legacy-item', userId: 'u_boundary', text: 'legacy', status: 'active' }]
});
fs.writeFileSync(itemsFile, original, 'utf8');

const governance = require('../utils/memoryGovernance');

assert.throws(
  () => governance.listMemoryItems(),
  (error) => error.code === 'MEMORY_LEGACY_STORAGE_DISABLED'
);
assert.throws(
  () => governance.updateMemoryItem('legacy-item', { status: 'archived' }),
  (error) => error.code === 'MEMORY_LEGACY_STORAGE_DISABLED'
);
assert.strictEqual(fs.readFileSync(itemsFile, 'utf8'), original);
assert.strictEqual(fs.existsSync(path.join(tempRoot, 'memory_snapshots')), false);

console.log('memoryV3GovernanceBoundary.test.js passed');
