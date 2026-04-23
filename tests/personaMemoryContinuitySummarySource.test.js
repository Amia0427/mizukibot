const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-persona-summary-source-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });

const { composePersonaMemoryState } = require('../utils/personaMemoryState');

module.exports = (async () => {
  const state = await composePersonaMemoryState({
    userId: 'u_summary_source',
    question: '我们刚才聊到哪了',
    sessionKey: 'direct:u_summary_source',
    routeMeta: {}
  }, {
    surface: 'direct_chat',
    memoryContext: {
      promptSummaryText: '这是一段检索摘要，不应该被回写成 continuity summary',
      summary: '这也是检索摘要',
      promptRetrievedMemoryText: '',
      taskMemoryText: '',
      groupMemoryText: '',
      persona: {},
      affinityState: {}
    },
    shortTermMemory: {
      'direct:u_summary_source': {
        summary: '',
        activeTopic: '真实会话话题',
        carryOverUserTurn: '真实遗留',
        openLoops: ['真实 open loop']
      }
    }
  });

  assert.strictEqual(String(state.continuityState.summary || '').trim(), '');
  console.log('personaMemoryContinuitySummarySource.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
