const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-open-boundary-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { openUnifiedMemory } = require('../utils/memoryCli');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_owner',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    text: '喜欢猫',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });
  materializeMemoryViews();

  const opened = openUnifiedMemory(
    { ref: 'mc_ref:profile:profile:u_owner:like:0' },
    {},
    { userId: 'u_other' }
  );
  assert.strictEqual(opened, null);
  console.log('memoryCliOpenBoundary.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
