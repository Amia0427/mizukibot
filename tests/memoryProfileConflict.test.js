const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-profile-conflict-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { buildStableProfileText } = require('../utils/memoryProfileSurface');

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'conflict-like',
    type: 'memory_candidate_extracted',
    ts: 1000,
    userId: 'u_conflict',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    conflictKey: 'u_conflict|personal|preference|同一对象',
    text: '喜欢同一对象',
    confidence: 0.95,
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    id: 'conflict-dislike-explicit',
    type: 'memory_confirmed',
    ts: 2000,
    userId: 'u_conflict',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'dislike',
    semanticSlot: 'preference_dislike',
    conflictKey: 'u_conflict|personal|preference|同一对象',
    text: '不喜欢同一对象',
    confidence: 1,
    payload: { fieldKey: 'preference_dislike', type: 'dislike' }
  });

  const result = materializeMemoryViews({ force: true });
  const profile = result.profileProjection.users.u_conflict;
  assert.ok(profile.strictProfile.dislikes.includes('不喜欢同一对象'));
  assert.ok(!profile.strictProfile.likes.includes('喜欢同一对象'));
  assert.ok(profile.conflicts.some((item) => item.id === 'conflict-like'));

  const surface = buildStableProfileText('u_conflict', { question: '普通聊天' });
  assert.ok(surface.text.includes('不喜欢同一对象'));
  assert.ok(!surface.strictItems.likes.includes('喜欢同一对象'));
  assert.ok(surface.conflicts.some((item) => item.id === 'conflict-like'));

  console.log('memoryProfileConflict.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
