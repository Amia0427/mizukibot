const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-weak-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');
const { assembleMemoryPacket } = require('../utils/memory-v3/packet');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    userId: 'u_weak',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    semanticSlot: 'topic',
    text: '最近在看显卡评测',
    payload: { fieldKey: 'topic', type: 'topic' },
    confidence: 0.92
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_weak',
    query: '最近在忙什么',
    facet: 'default'
  });
  const packet = assembleMemoryPacket(result, { userId: 'u_weak' });
  assert.ok(Array.isArray(result.weakResults));
  assert.ok(result.weakResults.length >= 1);
  assert.ok(String(packet.weakEvidenceText || '').includes('显卡'));
  console.log('memoryV3WeakEvidence.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
