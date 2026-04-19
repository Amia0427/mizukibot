const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-relationship-'));
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
    type: 'memory_confirmed',
    userId: 'u_rel',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_impression_support',
    text: '对熟悉用户会更自然、更愿意接话，但不失边界感。',
    payload: { fieldKey: 'persona_impression_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_rel',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    text: '关系更近时会更像熟人聊天，不会突然变得客套。',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_rel',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'style',
    text: 'style: 关系近时可以自然接话，但不要装腔。',
    payload: { fieldKey: 'style_pattern', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_rel',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'relationship_style',
    text: 'relationship_tone: 熟人感、自然接话',
    payload: { fieldKey: 'relationship_tone', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_rel',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'relationship_style',
    text: 'relationship_reply_style: 更像熟人聊天，不突然客套',
    payload: { fieldKey: 'relationship_reply_style', type: 'fact' }
  });

  const result = materializeMemoryViews();
  const queryResult = await queryMemory({
    userId: 'u_rel',
    query: '我们现在说话应该更像熟人一点还是保持距离？',
    facet: 'relationship'
  });
  const packet = assembleMemoryPacket(queryResult, { userId: 'u_rel' });

  assert.ok(queryResult.strictResults.some((item) => String(item.text || '').includes('熟人') || String(item.text || '').includes('边界')));
  assert.ok(String(packet.stableProfileText || '').includes('关系'));
  assert.ok(String(packet.stableProfileText || '').includes('关系风格'));
  assert.ok(String(result.profileProjection.users.u_rel.personaCore.relationshipStyle || '').includes('relationship_tone'));
  assert.ok(result.profileProjection.users.u_rel.personaCore.relationshipTone !== undefined);
  console.log('memoryV3RelationshipFacet.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
