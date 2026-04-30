const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-freshness-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
    process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
    process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'materialize.lock');
    process.env.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS = '600000';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
    process.env.MEMORY_EMBEDDING_MODEL = '';
    process.env.MEMORY_RERANK_ENABLED = 'false';
    clearProjectCache();

    fs.mkdirSync(process.env.MEMORY_V3_EVENTS_DIR, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
    fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

    const { appendMemoryEvent } = require('../utils/memory-v3/events');
    const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
    const { queryMemory } = require('../utils/memory-v3/query');
    const { restoreSessionState } = require('../utils/memory-v3/session');

    await appendMemoryEvent({
      type: 'session_checkpoint',
      ts: Date.UTC(2026, 3, 28, 10, 0, 0),
      userId: 'u_fresh',
      sessionKey: 'direct:u_fresh',
      scopeType: 'session',
      source: 'test',
      payload: {
        snapshotType: 'post_reply',
        summary: '旧快照里还在讨论旧长期记忆。',
        activeTopic: '旧长期记忆'
      }
    });
    await appendMemoryEvent({
      type: 'memory_confirmed',
      ts: Date.UTC(2026, 3, 28, 10, 1, 0),
      userId: 'u_fresh',
      scopeType: 'personal',
      source: 'explicit',
      sourceKind: 'explicit',
      status: 'active',
      memoryKind: 'preference_like',
      semanticSlot: 'preference_like',
      text: '喜欢旧口味',
      confidence: 0.99,
      payload: { fieldKey: 'preference_like', type: 'like' }
    });
    const initial = materializeMemoryViews({ force: true });
    assert.strictEqual(initial.ok, true);
    assert.strictEqual(initial.stats.latestEventTs, Date.UTC(2026, 3, 28, 10, 1, 0));

    const legacyMonthFile = path.join(process.env.MEMORY_V3_EVENTS_DIR, '2026-04.ndjson');
    fs.writeFileSync(legacyMonthFile, `${JSON.stringify({
      type: 'turn_replied',
      ts: Date.UTC(2026, 3, 27, 9, 0, 0),
      userId: 'u_fresh',
      sessionKey: 'direct:u_fresh',
      text: '旧月文件兼容事件'
    })}\n`, 'utf8');

    await appendMemoryEvent({
      type: 'session_checkpoint',
      ts: Date.UTC(2026, 3, 29, 10, 0, 0),
      userId: 'u_fresh',
      sessionKey: 'direct:u_fresh',
      scopeType: 'session',
      source: 'test',
      payload: {
        snapshotType: 'post_reply',
        summary: '新事件已经落盘，应该进入召回。',
        activeTopic: '新长期记忆'
      }
    });
    await appendMemoryEvent({
      type: 'memory_confirmed',
      ts: Date.UTC(2026, 3, 29, 10, 1, 0),
      userId: 'u_fresh',
      sessionKey: 'direct:u_fresh',
      scopeType: 'personal',
      source: 'explicit',
      sourceKind: 'explicit',
      status: 'active',
      memoryKind: 'preference_like',
      semanticSlot: 'preference_like',
      text: '喜欢新口味',
      confidence: 0.99,
      payload: { fieldKey: 'preference_like', type: 'like' }
    });

    fs.writeFileSync(process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE, JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now()
    }), 'utf8');
    const locked = materializeMemoryViews({ force: true });
    assert.strictEqual(locked.deferred, true);
    assert.strictEqual(locked.reason, 'materialize_lock_busy');

    const result = await queryMemory({
      userId: 'u_fresh',
      sessionKey: 'direct:u_fresh',
      query: '喜欢什么口味',
      facet: 'preference'
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.results.some((item) => String(item.text || '').includes('喜欢旧口味')));
    assert.ok(!result.results.some((item) => String(item.text || '').includes('喜欢新口味')));

    const freshness = result.diagnostics.projectionFreshness;
    assert.strictEqual(freshness.projectionStale, true);
    assert.strictEqual(freshness.projectionStaleReason, 'relevant_event_newer_than_projection');
    assert.strictEqual(freshness.latestRelevantEventTs, Date.UTC(2026, 3, 29, 10, 1, 0));
    assert.strictEqual(freshness.projectionEventHighWatermarkTs, Date.UTC(2026, 3, 28, 10, 1, 0));
    assert.strictEqual(freshness.materializeLock.hit, true);
    assert.strictEqual(freshness.lockHit, true);
    assert.strictEqual(freshness.usedOldSnapshot, true);
    assert.strictEqual(freshness.eventRead.dailyFileCount, 2);
    assert.strictEqual(freshness.eventRead.legacyMonthFileCount, 1);
    assert.ok(freshness.eventRead.files.includes('2026-04.ndjson'));
    assert.ok(freshness.eventRead.files.includes('2026-04-28.ndjson'));
    assert.ok(freshness.eventRead.files.includes('2026-04-29.ndjson'));
    assert.ok(freshness.projections.every((item) => item.eventHighWatermarkTs === Date.UTC(2026, 3, 28, 10, 1, 0)));

    const restored = await restoreSessionState('direct:u_fresh', { userId: 'u_fresh' });
    assert.strictEqual(restored.restored, true);
    assert.strictEqual(restored.diagnostics.projectionFreshness.usedOldSnapshot, true);
    assert.strictEqual(
      restored.diagnostics.projectionFreshness.usedOldSnapshotReason,
      'session_snapshot_older_than_relevant_event'
    );

    console.log('memoryV3ProjectionFreshnessDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
