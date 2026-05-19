const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-profile-rem-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS = '2';
process.env.MEMORY_PROFILE_MAINTENANCE_ENABLED = 'true';
process.env.MEMORY_PROFILE_NEAR_DUPLICATE_THRESHOLD = '0.7';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent, loadMemoryEvents } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');
const { runProfileMemoryMaintenance } = require('../utils/memory-v3/profileMaintenance');

const now = Date.now();

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'latte-like',
    type: 'memory_confirmed',
    ts: now,
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    conflictKey: 'u_profile_rem|personal|preference|latte',
    text: '喜欢拿铁',
    confidence: 0.98,
    payload: { type: 'like', fieldKey: 'preference_like', conflictKey: 'u_profile_rem|personal|preference|latte' }
  });
  await appendMemoryEvent({
    id: 'correction-yuzu',
    type: 'memory_confirmed',
    ts: now + 1000,
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    conflictKey: 'u_profile_rem|personal|preference|yuzu',
    text: '纠正一下，不是喜欢拿铁，而是喜欢柚子茶',
    confidence: 0.99,
    payload: { type: 'like', fieldKey: 'preference_like', conflictKey: 'u_profile_rem|personal|preference|yuzu' }
  });

  let events = loadMemoryEvents();
  assert.ok(events.some((event) => event.type === 'memory_archived' && event.id === 'latte-like'));
  assert.ok(events.some((event) => event.id === 'correction-yuzu' && event.text === '喜欢柚子茶'));

  await appendMemoryEvent({
    id: 'goal-dup-old',
    type: 'memory_confirmed',
    ts: now + 2000,
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'goal',
    semanticSlot: 'goal',
    text: '目标是完成画像治理剩余目标',
    confidence: 0.92,
    payload: { type: 'goal', fieldKey: 'goal' }
  });
  await appendMemoryEvent({
    id: 'goal-dup-new',
    type: 'memory_confirmed',
    ts: now + 3000,
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'goal',
    semanticSlot: 'goal',
    text: '目标：完成画像治理剩余目标',
    confidence: 0.99,
    payload: { type: 'goal', fieldKey: 'goal' }
  });
  await appendMemoryEvent({
    id: 'old-topic-cleanup',
    type: 'memory_candidate_extracted',
    ts: now - (6 * 24 * 3600 * 1000),
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    semanticSlot: 'topic',
    text: '很久前的临时话题',
    confidence: 0.95,
    payload: { type: 'topic', fieldKey: 'topic' }
  });
  await appendMemoryEvent({
    id: 'forget-command',
    type: 'memory_confirmed',
    ts: now + 4000,
    userId: 'u_profile_rem',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '别记喜欢拿铁',
    confidence: 0.99,
    payload: { type: 'like', fieldKey: 'preference_like' }
  });

  const materialized = materializeMemoryViews({ force: true });
  const oldGoal = materialized.nodes.find((item) => item.id === 'goal-dup-old');
  const newGoal = materialized.nodes.find((item) => item.id === 'goal-dup-new');
  assert.strictEqual(oldGoal.lifecycleStatus, 'superseded');
  assert.strictEqual(oldGoal.supersededBy, 'goal-dup-new');
  assert.strictEqual(newGoal.lifecycleStatus, 'active');
  const forgetCommand = materialized.nodes.find((item) => item.id === 'forget-command');
  assert.strictEqual(forgetCommand.lifecycleStatus, 'suspect');
  assert.strictEqual(forgetCommand.notRecallable, true);

  const recall = await queryMemory({
    userId: 'u_profile_rem',
    query: '我的目标是什么',
    facet: 'identity'
  });
  assert.ok(recall.results.some((item) => item.text.includes('完成画像治理剩余目标')));
  const recalledGoal = recall.results.find((item) => item.text.includes('完成画像治理剩余目标'));
  assert.ok(recalledGoal.scoreParts.profileLifecycleBoost >= 0);
  assert.ok(!recall.results.some((item) => item.id === 'goal-dup-old'));

  const maintenance = await runProfileMemoryMaintenance({ force: true, limit: 10 });
  assert.strictEqual(maintenance.ok, true);
  assert.ok(maintenance.cleanupCandidates >= 1);
  assert.ok(maintenance.candidates.some((item) => item.id === 'old-topic-cleanup' && item.lifecycleStatus === 'stale'));

  console.log('memoryV3ProfileLifecycleRemainders.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
