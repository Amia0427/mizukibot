const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-parity-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { runMemoryCli } = require('../utils/memoryCli');

function overlapRatio(a = [], b = []) {
  const setB = new Set(b);
  if (!a.length) return 1;
  let hit = 0;
  for (const item of a) {
    if (setB.has(item)) hit += 1;
  }
  return hit / a.length;
}

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_parity',
    sessionKey: 'direct:u_parity',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '旅行计划',
      carryOverUserTurn: '继续上次旅行安排',
      summary: '刚才在讨论旅行计划'
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_parity',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '海边',
    text: '喜欢海边旅行',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_parity',
    groupId: 'g_parity',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'jargon',
    semanticSlot: 'group_jargon',
    canonicalKey: '开车',
    text: '群里把带节奏叫开车',
    payload: { type: 'jargon', fieldKey: 'group_jargon' }
  });
  materializeMemoryViews();

  const notebookDir = path.join(tempRoot, 'notebook', 'u_parity');
  fs.mkdirSync(notebookDir, { recursive: true });
  const notePath = path.join(notebookDir, 'trip.md');
  fs.writeFileSync(notePath, '旅行 markdown 文档里记录了海边安排', 'utf8');
  delete require.cache[require.resolve('../utils/localKnowledge')];
  const { updateNotebookIndexIncremental } = require('../utils/localKnowledge');
  updateNotebookIndexIncremental({ userId: 'u_parity' }, notePath);

  process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
  const fastAll = await runMemoryCli('mem search --query "继续上次旅行安排"', {
    userId: 'u_parity',
    groupId: 'g_parity',
    sessionKey: 'direct:u_parity',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });

  const fastNotebook = await runMemoryCli('mem search --source notebook --query "markdown 文档"', {
    userId: 'u_parity',
    sessionKey: 'direct:u_parity'
  });

  process.env.MEMORY_CLI_SEARCH_ENGINE = 'legacy';
  const legacyAll = await runMemoryCli('mem search --query "继续上次旅行安排"', {
    userId: 'u_parity',
    groupId: 'g_parity',
    sessionKey: 'direct:u_parity',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });

  const legacyNotebook = await runMemoryCli('mem search --source notebook --query "markdown 文档"', {
    userId: 'u_parity',
    sessionKey: 'direct:u_parity'
  });

  const fastAllRefs = (fastAll.results || []).slice(0, 5).map((item) => item.ref);
  const legacyAllRefs = (legacyAll.results || []).slice(0, 5).map((item) => item.ref);
  const fastNotebookRefs = (fastNotebook.results || []).slice(0, 3).map((item) => item.ref);
  const legacyNotebookRefs = (legacyNotebook.results || []).slice(0, 3).map((item) => item.ref);

  assert.ok(overlapRatio(fastAllRefs, legacyAllRefs) >= 0.7, 'expected source=all overlap >= 0.7');
  assert.ok(overlapRatio(fastNotebookRefs, legacyNotebookRefs) >= 0.9, 'expected notebook overlap >= 0.9');
  console.log('memoryCliFastLegacyParity.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
