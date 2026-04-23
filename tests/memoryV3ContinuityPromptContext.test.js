const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-continuity-prompt-'));
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
const { buildMemoryContextAsync } = require('../utils/memoryContext');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_cont_prompt',
    sessionKey: 'direct:u_cont_prompt',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      summary: '刚才在讨论 Linux 服务器部署和 systemd 重启策略。',
      activeTopic: '服务器部署',
      carryOverUserTurn: '你还没回答 systemd 配置怎么写'
    }
  });
  materializeMemoryViews();

  const result = await buildMemoryContextAsync(
    'u_cont_prompt',
    '我们刚才聊到哪了，你还没回答我什么？',
    {
      sessionKey: 'direct:u_cont_prompt',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    }
  );

  assert.ok(String(result.promptRetrievedMemoryText || '').includes('systemd'));
  assert.ok(String(result.promptSummaryText || '').includes('systemd'));
  console.log('memoryV3ContinuityPromptContext.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
