const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-packet-budget-'));
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
const { estimateMessagesTokens } = require('../utils/contextBudget');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_budget',
    sessionKey: 'direct:u_budget',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      summary: '最近在持续讨论 Linux 服务器运维、部署和排错。',
      activeTopic: '服务器运维'
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_budget',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    text: '偏好直接结论，不喜欢长铺垫。',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_budget',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    text: '更看重结论和可执行步骤。',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_budget',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_impression_support',
    text: '整体人格应偏直接、收束、协作导向。',
    payload: { fieldKey: 'persona_impression_support', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_budget',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    text: '喜欢清晰步骤',
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    userId: 'u_budget',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    text: '最近在看部署脚本',
    payload: { fieldKey: 'topic', type: 'topic' },
    confidence: 0.92
  });

  materializeMemoryViews();
  const result = await queryMemory({
    userId: 'u_budget',
    query: '我们刚才聊到哪了，以及我喜欢什么样的回答风格？',
    facet: 'default'
  });
  const packet = assembleMemoryPacket(result, { userId: 'u_budget' });
  const messageList = [
    ...(packet.messages.sessionContinuity || []),
    ...(packet.messages.stableProfile || []),
    ...(packet.messages.relevantEvidence || []),
    ...(packet.messages.weakEvidence || []),
    ...(packet.messages.taskStrategy || []),
    ...(packet.messages.groupSharedContext || []),
    ...(packet.messages.styleSignals || [])
  ];
  const tokens = estimateMessagesTokens(messageList);
  assert.ok(tokens <= 820, `expected packet tokens to stay bounded, got ${tokens}`);
  console.log('memoryPacketBudget.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
