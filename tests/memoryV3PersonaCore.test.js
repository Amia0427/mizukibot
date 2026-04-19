const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-persona-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    semanticSlot: 'persona_summary_support',
    text: '是一个说话直接但不喜欢铺垫的用户',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    semanticSlot: 'persona_summary_support',
    text: '偏好结论先行，讨厌空话',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_impression_support',
    semanticSlot: 'persona_impression_support',
    text: '整体风格偏直接、收束、结果导向',
    payload: { fieldKey: 'persona_impression_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'bot_persona',
    semanticSlot: 'bot_persona_tone',
    text: 'bot_persona_tone: 直接、结论先行',
    payload: { fieldKey: 'bot_persona_tone', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_persona',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'bot_persona',
    semanticSlot: 'bot_persona_verbosity',
    text: 'bot_persona_verbosity: terse',
    payload: { fieldKey: 'bot_persona_verbosity', type: 'fact' }
  });

  const result = materializeMemoryViews();
  const profile = result.profileProjection.users.u_persona;
  assert.ok(profile);
  assert.ok(String(profile.personaCore.summary || '').includes('直接'));
  assert.ok(String(profile.personaCore.impression || '').includes('结果导向'));
  assert.ok(String(profile.personaCore.botBasePersona || '').includes('bot_persona_tone'));
  assert.strictEqual(Number(profile.personaCore.personaVersion || 0), 2);
  console.log('memoryV3PersonaCore.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
