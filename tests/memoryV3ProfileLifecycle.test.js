const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-profile-life-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_PROFILE_DEFAULT_TTL_DAYS = '7';
process.env.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS = '3';
process.env.MEMORY_PROFILE_INJECT_WEAK_ITEMS = 'true';
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');
const { buildStableProfileText } = require('../utils/memoryProfileSurface');
const {
  assessProfileWriteQuality,
  formatPromptProfileSurface
} = require('../utils/memory-v3/profileLifecycle');

const now = Date.now();

module.exports = (async () => {
  assert.strictEqual(assessProfileWriteQuality('like', '喜欢', 0.99).ok, false);
  assert.ok(formatPromptProfileSurface('身份信息：工程师\n低置信偏好：可能喜欢短答').includes('谨慎参考'));

  await appendMemoryEvent({
    id: 'old-topic-life',
    type: 'memory_candidate_extracted',
    ts: now - (10 * 24 * 3600 * 1000),
    userId: 'u_life',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    semanticSlot: 'topic',
    text: '十天前的临时话题',
    confidence: 0.95,
    payload: { fieldKey: 'topic', type: 'topic' }
  });
  await appendMemoryEvent({
    id: 'suspect-life',
    type: 'memory_candidate_extracted',
    ts: now,
    userId: 'u_life',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '今天临时喜欢某个测试项',
    confidence: 0.95,
    payload: {
      fieldKey: 'preference_like',
      type: 'like',
      profileQuality: {
        ok: false,
        reasons: ['temporary_language'],
        confidence: 0.95,
        sourceKind: 'extractor'
      }
    }
  });
  await appendMemoryEvent({
    id: 'old-goal-life',
    type: 'memory_confirmed',
    ts: now + 1000,
    userId: 'u_life',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'goal',
    semanticSlot: 'goal',
    conflictKey: 'u_life|personal|goal|current-main-goal',
    text: '旧目标：先写 A',
    confidence: 0.99,
    payload: { fieldKey: 'goal', type: 'goal', conflictKey: 'u_life|personal|goal|current-main-goal' }
  });
  await appendMemoryEvent({
    id: 'new-goal-life',
    type: 'memory_confirmed',
    ts: now + 2000,
    userId: 'u_life',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'goal',
    semanticSlot: 'goal',
    conflictKey: 'u_life|personal|goal|current-main-goal',
    text: '新目标：先写 B',
    confidence: 0.99,
    payload: { fieldKey: 'goal', type: 'goal', conflictKey: 'u_life|personal|goal|current-main-goal' }
  });

  const materialized = materializeMemoryViews({ force: true });
  const nodes = materialized.nodes;
  const oldTopic = nodes.find((item) => item.id === 'old-topic-life');
  const suspect = nodes.find((item) => item.id === 'suspect-life');
  const oldGoal = nodes.find((item) => item.id === 'old-goal-life');
  const newGoal = nodes.find((item) => item.id === 'new-goal-life');
  assert.strictEqual(oldTopic.lifecycleStatus, 'stale');
  assert.strictEqual(oldTopic.notRecallable, true);
  assert.strictEqual(suspect.lifecycleStatus, 'suspect');
  assert.strictEqual(suspect.notRecallable, true);
  assert.strictEqual(oldGoal.lifecycleStatus, 'superseded');
  assert.strictEqual(oldGoal.supersededBy, 'new-goal-life');
  assert.strictEqual(newGoal.lifecycleStatus, 'active');

  const profile = materialized.profileProjection.users.u_life;
  assert.ok(profile.strictProfile.goals.includes('新目标：先写 B'));
  assert.ok(!profile.strictProfile.goals.includes('旧目标：先写 A'));
  assert.ok(profile.suppressed.some((item) => item.reason === 'profile_lifecycle_stale'));
  assert.ok(profile.suppressed.some((item) => item.reason === 'profile_lifecycle_suspect'));
  assert.ok(profile.conflicts.some((item) => item.id === 'old-goal-life'));

  const recall = await queryMemory({
    userId: 'u_life',
    query: '我的目标是什么',
    facet: 'identity'
  });
  assert.ok(recall.results.some((item) => item.text.includes('新目标')));
  assert.ok(!recall.results.some((item) => item.text.includes('旧目标')));
  assert.ok(!recall.results.some((item) => item.text.includes('临时喜欢')));

  const surface = buildStableProfileText('u_life', { question: '你怎么看我的画像', includeWeak: true });
  assert.strictEqual(surface.source, 'profile_journal_db');
  assert.ok(surface.text.includes('稳定画像'));
  assert.ok(surface.text.includes('新目标：先写 B'));
  assert.ok(!surface.text.includes('旧目标：先写 A'));
  assert.ok(!surface.text.includes('临时喜欢'));
  assert.ok(surface.text.includes('使用规则'));

  console.log('memoryV3ProfileLifecycle.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
