const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-fast-'));
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
    userId: 'u_fast',
    sessionKey: 'direct:u_fast',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      activeTopic: '部署',
      carryOverUserTurn: '继续上次部署问题',
      summary: '刚才在讨论部署排查',
      openLoops: ['补充 systemd 配置']
    }
  });

  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_fast',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '猫',
    text: '喜欢猫',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });

  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_fast',
    groupId: 'g_fast',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'jargon',
    semanticSlot: 'group_jargon',
    canonicalKey: '开荒',
    text: '群里会说开荒',
    payload: { type: 'jargon', fieldKey: 'group_jargon' }
  });

  materializeMemoryViews();

  const notebookDir = path.join(tempRoot, 'notebook', 'u_fast');
  fs.mkdirSync(notebookDir, { recursive: true });
  fs.writeFileSync(path.join(notebookDir, 'deploy.md'), 'systemd 部署说明和 journalctl 命令', 'utf8');
  delete require.cache[require.resolve('../utils/localKnowledge')];
  const { updateNotebookIndexIncremental } = require('../utils/localKnowledge');
  updateNotebookIndexIncremental({ userId: 'u_fast' }, path.join(notebookDir, 'deploy.md'));

  const preference = await runMemoryCli('mem search --query "喜欢什么"', {
    userId: 'u_fast',
    sessionKey: 'direct:u_fast',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(preference.ok, true);
  assert.ok(Array.isArray(preference.results));
  assert.ok(preference.results.some((item) => String(item.preview || '').includes('喜欢猫')));
  assert.ok(Object.prototype.hasOwnProperty.call(preference, 'queryFacet'));
  assert.ok(Object.prototype.hasOwnProperty.call(preference, 'sourceCoverage'));
  assert.ok(Object.prototype.hasOwnProperty.call(preference, 'candidateCounts'));

  const continuity = await runMemoryCli('mem search --query "继续上次部署问题"', {
    userId: 'u_fast',
    sessionKey: 'direct:u_fast',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(continuity.ok, true);
  assert.ok(continuity.results.some((item) => item.source === 'recent'));

  const notebook = await runMemoryCli('mem search --source notebook --query "journalctl"', {
    userId: 'u_fast',
    sessionKey: 'direct:u_fast'
  });
  assert.strictEqual(notebook.ok, true);
  assert.ok(notebook.results.every((item) => item.source === 'notebook'));

  const group = await runMemoryCli('mem search --source jargon --query "开荒"', {
    userId: 'u_fast',
    groupId: 'g_fast',
    sessionKey: 'group:g_fast'
  });
  assert.strictEqual(group.ok, true);
  assert.ok(group.results.every((item) => item.source === 'jargon'));

  const openRef = preference.results[0].ref;
  const opened = await runMemoryCli(`mem open --ref "${openRef}"`, {
    userId: 'u_fast',
    sessionKey: 'direct:u_fast',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  assert.strictEqual(opened.ok, true);
  assert.ok(opened.data);

  console.log('memoryCliFastRuntime.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
