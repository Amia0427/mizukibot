const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-recent-fast-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  const now = Date.now();
  await appendMemoryEvent({
    id: 'recent-session-fast',
    type: 'session_checkpoint',
    ts: now,
    userId: 'u_recent_fast',
    sessionKey: 'direct:u_recent_fast',
    scopeType: 'session',
    source: 'test',
    payload: {
      snapshotType: 'post_reply',
      summary: '我们正在排查 WebSocket 连接重连策略，下一步要改指数退避参数。',
      activeTopic: 'WebSocket 重连策略',
      openLoops: ['还没给出指数退避参数范围']
    }
  });
  await appendMemoryEvent({
    id: 'old-profile-fast',
    type: 'memory_confirmed',
    ts: now - (180 * 24 * 3600 * 1000),
    userId: 'u_recent_fast',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢泛泛讨论项目管理方法',
    confidence: 1,
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      category: 'preference'
    }
  });
  materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });

  const result = await queryMemory({
    userId: 'u_recent_fast',
    query: '刚才说到哪了，下一步是什么',
    sessionKey: 'direct:u_recent_fast',
    topK: 4
  });

  assert.strictEqual(result.facet, 'continuity');
  assert.strictEqual(result.diagnostics.recentRecallIntent.matched, true);
  assert.ok(result.results.length > 0);
  assert.strictEqual(result.results[0].source, 'recent');
  assert.ok(String(result.results[0].text || '').includes('WebSocket'));
  assert.ok(
    String(result.results[0].selectionReason || '').includes('facet_continuity_selected')
      || String(result.results[0].selectionReason || '').includes('recent_recall_fallback')
  );

  console.log('memoryV3RecentRecallFastPath.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
