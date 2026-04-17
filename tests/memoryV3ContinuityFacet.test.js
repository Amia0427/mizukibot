const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-continuity-'));
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

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_cont',
    sessionKey: 'direct:u_cont',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      summary: '刚才在讨论 Linux 服务器部署和 systemd 重启策略。',
      activeTopic: '服务器部署',
      carryOverUserTurn: '你还没回答 systemd 配置怎么写'
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_cont',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    text: '喜欢清晰步骤',
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_cont',
    query: '我们刚才聊到哪了，你还没回答我什么？',
    facet: 'continuity'
  });

  assert.ok(result.results.some((item) => String(item.text || '').includes('systemd')));
  assert.ok(result.results.some((item) => String(item.source || '') === 'recent'));
  console.log('memoryV3ContinuityFacet.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
