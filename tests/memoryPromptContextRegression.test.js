const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-prompt-regression-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'true';
process.env.PROMPT_OPTIONAL_BUILD_BUDGET_MS = '500';
process.env.MEMORY_RETRIEVAL_SOFT_BUDGET_MS = '800';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_prompt_mem',
    sessionKey: 'direct:u_prompt_mem',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      summary: '刚刚在聊部署脚本、错误排查和下一步要怎么继续。',
      activeTopic: '部署排查',
      openLoops: ['还没给出下一步排查顺序']
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_prompt_mem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    text: '喜欢先给结论，再给步骤',
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_prompt_mem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'persona_summary_support',
    text: '偏好直接、收束、可执行的回答。',
    payload: { fieldKey: 'persona_summary_support', type: 'fact' }
  });
  materializeMemoryViews();

  const result = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_mem',
    '你还记得我们刚才聊到哪了吗？我喜欢什么样的回答方式？',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {},
      continuitySignals: {
        hasCarryOverTopic: true,
        hasOpenLoop: true,
        quoteAnchored: false
      }
    }
  );

  const dynamicIds = Array.isArray(result.dynamicContextBlocks)
    ? result.dynamicContextBlocks.map((item) => item.id)
    : [];
  const assistantOnlyIds = Array.isArray(result.assistantOnlyContextBlocks)
    ? result.assistantOnlyContextBlocks.map((item) => item.id)
    : [];

  assert.ok(dynamicIds.includes('retrieved_memory_lite'), 'retrieved memory should be part of dynamic context');
  assert.ok(dynamicIds.includes('long_term_profile'), 'long-term profile should remain available alongside persona memory');
  assert.ok(!assistantOnlyIds.includes('retrieved_memory_lite'), 'retrieved memory should not be assistant-only');

  console.log('memoryPromptContextRegression.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
