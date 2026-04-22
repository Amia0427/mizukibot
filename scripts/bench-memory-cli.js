const fs = require('fs');
const os = require('os');
const path = require('path');

function percentile(values = [], ratio = 0.5) {
  const list = Array.isArray(values) ? values.slice().sort((a, b) => a - b) : [];
  if (!list.length) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(list.length * ratio) - 1));
  return list[index];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-bench-'));
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
  const { updateNotebookIndexIncremental } = require('../utils/localKnowledge');

  for (let i = 0; i < 60; i += 1) {
    await appendMemoryEvent({
      type: 'memory_confirmed',
      userId: 'u_bench',
      scopeType: 'personal',
      source: 'explicit',
      sourceKind: 'explicit',
      status: 'active',
      memoryKind: i % 5 === 0 ? 'style' : 'like',
      semanticSlot: i % 5 === 0 ? 'style_pattern' : 'preference_like',
      canonicalKey: `偏好_${i}`,
      text: i % 5 === 0 ? `说话风格偏好_${i}` : `喜欢主题_${i}`,
      payload: { type: i % 5 === 0 ? 'style' : 'like', fieldKey: i % 5 === 0 ? 'style_pattern' : 'preference_like' }
    });
  }

  for (let i = 0; i < 20; i += 1) {
    await appendMemoryEvent({
      type: 'session_checkpoint',
      userId: 'u_bench',
      sessionKey: `direct:u_bench:${i}`,
      scopeType: 'session',
      source: 'test',
      payload: {
        snapshotType: 'post_reply',
        activeTopic: `部署_${i}`,
        carryOverUserTurn: `继续话题_${i}`,
        summary: `刚才在讨论部署_${i}`,
        openLoops: [`待办_${i}`]
      }
    });
  }

  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_bench',
    groupId: 'g_bench',
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

  materializeMemoryViews();

  const notebookDir = path.join(tempRoot, 'notebook', 'u_bench');
  fs.mkdirSync(notebookDir, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const filePath = path.join(notebookDir, `doc_${i}.md`);
    fs.writeFileSync(filePath, `markdown 文档 ${i}，包含部署说明和 journalctl 命令`, 'utf8');
    updateNotebookIndexIncremental({ userId: 'u_bench' }, filePath);
  }

  const coldStartedAt = Date.now();
  const coldSearch = await runMemoryCli('mem search --query "继续部署话题"', {
    userId: 'u_bench',
    groupId: 'g_bench',
    sessionKey: 'direct:u_bench:1',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat'
  });
  const coldMs = Date.now() - coldStartedAt;

  const warmAllTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const startedAt = Date.now();
    await runMemoryCli('mem search --query "继续部署话题"', {
      userId: 'u_bench',
      groupId: 'g_bench',
      sessionKey: 'direct:u_bench:1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    });
    warmAllTimes.push(Date.now() - startedAt);
  }

  const warmSingleTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const startedAt = Date.now();
    await runMemoryCli('mem search --source notebook --query "journalctl"', {
      userId: 'u_bench',
      sessionKey: 'direct:u_bench:1'
    });
    warmSingleTimes.push(Date.now() - startedAt);
  }

  const openRef = coldSearch.results?.[0]?.ref || 'mc_ref:recent:session:direct:u_bench:1';
  const openTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const startedAt = Date.now();
    await runMemoryCli(`mem open --ref "${openRef}"`, {
      userId: 'u_bench',
      groupId: 'g_bench',
      sessionKey: 'direct:u_bench:1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    });
    openTimes.push(Date.now() - startedAt);
  }

  console.log(JSON.stringify({
    cold: {
      searchMs: coldMs
    },
    warm: {
      searchAll: {
        p50: percentile(warmAllTimes, 0.5),
        p95: percentile(warmAllTimes, 0.95),
        samples: warmAllTimes
      },
      searchSingle: {
        p50: percentile(warmSingleTimes, 0.5),
        p95: percentile(warmSingleTimes, 0.95),
        samples: warmSingleTimes
      },
      open: {
        p50: percentile(openTimes, 0.5),
        p95: percentile(openTimes, 0.95),
        samples: openTimes
      }
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
