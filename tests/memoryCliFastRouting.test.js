const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-routing-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { runMemoryCli } = require('../utils/memoryCli');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId: 'u_route',
    sessionKey: 'direct:u_route',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '群活动',
      carryOverUserTurn: '继续刚才的话题',
      summary: '刚才在讨论群活动安排'
    }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_route',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '奶茶',
    text: '喜欢奶茶',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_route',
    groupId: 'g_route',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'jargon',
    semanticSlot: 'group_jargon',
    canonicalKey: '团建',
    text: '群里把活动叫团建',
    payload: { type: 'jargon', fieldKey: 'group_jargon' }
  });
  materializeMemoryViews({ force: true });

  const notebookDir = path.join(tempRoot, 'notebook', 'u_route');
  fs.mkdirSync(notebookDir, { recursive: true });
  const notePath = path.join(notebookDir, 'ops.md');
  fs.writeFileSync(notePath, 'markdown 笔记里有群活动文档', 'utf8');
  delete require.cache[require.resolve('../utils/localKnowledge')];
  const { updateNotebookIndexIncremental } = require('../utils/localKnowledge');
  updateNotebookIndexIncremental({ userId: 'u_route' }, notePath);

  const continuity = await runMemoryCli('mem search --query "继续刚才的话题"', {
    userId: 'u_route',
    sessionKey: 'direct:u_route',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(continuity.ok, true);
  assert.ok(['recent_continuity', 'task_or_plan'].includes(continuity.queryFacet));
  assert.strictEqual(continuity.results[0].source, 'recent');
  assert.ok(['strong', 'usable'].includes(continuity.results[0].evidenceQuality));
  assert.strictEqual(continuity.qualitySummary.hasUsableEvidence, true);
  assert.strictEqual(typeof continuity.rejectedResultCount, 'number');

  const preference = await runMemoryCli('mem search --query "你喜欢喝什么"', {
    userId: 'u_route',
    sessionKey: 'direct:u_route'
  });
  assert.strictEqual(preference.ok, true);
  assert.ok(['profile', 'personal'].includes(preference.results[0].source));
  assert.ok(['strong', 'usable'].includes(preference.results[0].evidenceQuality));

  const group = await runMemoryCli('mem search --query "群里怎么说这个活动"', {
    userId: 'u_route',
    groupId: 'g_route',
    sessionKey: 'group:g_route'
  });
  assert.strictEqual(group.ok, true);
  assert.ok(group.results.some((item) => item.source === 'jargon' || item.source === 'group'));

  const notebook = await runMemoryCli('mem search --source notebook --query "markdown 文档"', {
    userId: 'u_route',
    sessionKey: 'direct:u_route'
  });
  assert.strictEqual(notebook.ok, true);
  assert.ok(notebook.results.every((item) => item.source === 'notebook'));
  assert.strictEqual(Object.keys(notebook.sourceCoverage).join(','), 'notebook');

  const weakOnly = await runMemoryCli('mem search --query "完全不相关的宇宙飞船问题" --source profile --limit 3', {
    userId: 'u_route',
    sessionKey: 'direct:u_route'
  });
  assert.strictEqual(weakOnly.ok, true);
  assert.strictEqual(weakOnly.qualitySummary.hasUsableEvidence, false);
  assert.strictEqual(weakOnly.results.length, 0);
  assert.ok(weakOnly.rejectedResultCount >= 0);

  console.log('memoryCliFastRouting.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
