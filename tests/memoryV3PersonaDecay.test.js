const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-persona-decay-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { materializeMemoryViews } = require('../utils/memory-v3/materializer');

module.exports = (async () => {
  const now = Date.now();
  const oldTs = now - (240 * 24 * 3600 * 1000);
  const recentTs = now - (5 * 24 * 3600 * 1000);
  const result = materializeMemoryViews({
    events: [
      {
        id: 'old_rel',
        type: 'memory_confirmed',
        ts: oldTs,
        userId: 'u_decay',
        scopeType: 'personal',
        source: 'explicit_feedback',
        sourceKind: 'explicit',
        status: 'active',
        memoryKind: 'relationship_style',
        semanticSlot: 'relationship_tone',
        text: 'relationship_tone: 非常拘谨',
        payload: { fieldKey: 'relationship_tone', type: 'fact' },
        confidence: 0.88,
        importance: 0.72,
        evidenceCount: 2
      },
      {
        id: 'new_rel',
        type: 'memory_confirmed',
        ts: recentTs,
        userId: 'u_decay',
        scopeType: 'personal',
        source: 'explicit_feedback',
        sourceKind: 'explicit',
        status: 'active',
        memoryKind: 'relationship_style',
        semanticSlot: 'relationship_tone',
        text: 'relationship_tone: 更自然接话',
        payload: { fieldKey: 'relationship_tone', type: 'fact' },
        confidence: 0.86,
        importance: 0.74,
        evidenceCount: 2
      }
    ]
  });

  const profile = result.profileProjection.users.u_decay;
  assert.ok(profile);
  assert.ok(String(profile.personaCore.relationshipStyle || '').includes('更自然接话'));
  console.log('memoryV3PersonaDecay.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
