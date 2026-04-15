const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-v3-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { runMemoryCli } = require('../utils/memoryCli');

(async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_cli',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'like',
    canonicalKey: '猫',
    text: '喜欢猫',
    payload: { type: 'like' }
  });
  materializeMemoryViews();

  const payload = await runMemoryCli('mem search --query "喜欢什么"', {
    userId: 'u_cli',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });

  assert.strictEqual(payload.ok, true);
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.some((item) => String(item.preview || '').includes('喜欢猫')));
  console.log('memoryCliV3.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
