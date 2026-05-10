const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-profile-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_V3_CANDIDATE_CONFIRMATIONS_REQUIRED = '2';
process.env.MEMORY_V3_STRICT_CONFIRM_CONFIDENCE = '0.82';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const now = Date.now();

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    ts: now + 1000,
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢单次观察项',
    confidence: 0.95,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    ts: now + 1001,
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'personality',
    semanticSlot: 'personality',
    text: '说话直接',
    confidence: 0.95,
    payload: { fieldKey: 'personality', type: 'personality' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    ts: now + 1002,
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    semanticSlot: 'topic',
    text: '今天聊过短期话题',
    confidence: 0.95,
    payload: { fieldKey: 'topic', type: 'topic' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    ts: now + 1003,
    id: 'like-repeat-a',
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢重复证据项',
    confidence: 0.9,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    ts: now + 1004,
    id: 'like-repeat-b',
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢重复证据项',
    confidence: 0.9,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    ts: now + 1005,
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢显式记住项',
    confidence: 0.99,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });

  const result = materializeMemoryViews({ force: true });
  const profile = result.profileProjection.users.u_profile_v3;
  assert.ok(profile);
  assert.ok(profile.weakProfile.single_hit_preferences.includes('喜欢单次观察项'));
  assert.ok(profile.weakProfile.single_hit_traits.includes('说话直接'));
  assert.ok(profile.weakProfile.recent_topics.includes('今天聊过短期话题'));
  assert.ok(!profile.strictProfile.likes.includes('喜欢单次观察项'));
  assert.ok(profile.strictProfile.likes.includes('喜欢重复证据项'));
  assert.ok(profile.strictProfile.likes.includes('喜欢显式记住项'));
  assert.ok(!profile.strictProfile.likes.includes('今天聊过短期话题'));

  await appendMemoryEvent({
    type: 'memory_confirmed',
    ts: now + 2000,
    userId: 'u_profile_other',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '另一个用户的旧投影',
    confidence: 0.99,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  materializeMemoryViews({ force: true });

  await appendMemoryEvent({
    type: 'memory_confirmed',
    ts: now + 3000,
    userId: 'u_profile_v3',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'goal',
    semanticSlot: 'goal',
    text: '增量刷新后的目标',
    confidence: 0.99,
    payload: { fieldKey: 'goal', type: 'goal' }
  });
  const incremental = materializeMemoryViews({
    mode: 'incremental',
    dirtyScopes: { userId: 'u_profile_v3' }
  });
  assert.strictEqual(incremental.stats.materializeMode, 'incremental');
  assert.ok(incremental.profileProjection.users.u_profile_v3.strictProfile.goals.includes('增量刷新后的目标'));
  assert.ok(incremental.profileProjection.users.u_profile_other.strictProfile.likes.includes('另一个用户的旧投影'));

  console.log('memoryV3MaterializerProfile.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
