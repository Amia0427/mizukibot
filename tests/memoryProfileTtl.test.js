const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-profile-ttl-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS = '14';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { buildStableProfileText } = require('../utils/memoryProfileSurface');

const now = Date.now();
const oldTs = now - (20 * 24 * 3600 * 1000);
const freshTs = now - (2 * 24 * 3600 * 1000);

const result = materializeMemoryViews({
  force: true,
  events: [
    {
      id: 'old-topic',
      type: 'memory_candidate_extracted',
      ts: oldTs,
      userId: 'u_ttl',
      scopeType: 'personal',
      source: 'extractor',
      sourceKind: 'extractor',
      status: 'candidate',
      memoryKind: 'topic',
      semanticSlot: 'topic',
      text: '过期近期话题',
      confidence: 0.95,
      payload: { fieldKey: 'topic', type: 'topic' }
    },
    {
      id: 'fresh-topic',
      type: 'memory_candidate_extracted',
      ts: freshTs,
      userId: 'u_ttl',
      scopeType: 'personal',
      source: 'extractor',
      sourceKind: 'extractor',
      status: 'candidate',
      memoryKind: 'topic',
      semanticSlot: 'topic',
      text: '新鲜近期话题',
      confidence: 0.95,
      payload: { fieldKey: 'topic', type: 'topic' }
    }
  ]
});

const profile = result.profileProjection.users.u_ttl;
assert.ok(profile.weakProfile.recent_topics.includes('新鲜近期话题'));
assert.ok(!profile.weakProfile.recent_topics.includes('过期近期话题'));
assert.ok(profile.suppressed.some((item) => item.id === 'old-topic' && item.reason === 'recent_topic_expired'));

const surface = buildStableProfileText('u_ttl', { question: '你怎么看我的画像', includeWeak: true, nowTs: now });
assert.ok(surface.text.includes('新鲜近期话题'));
assert.ok(!surface.text.includes('过期近期话题'));
assert.ok(surface.suppressed.some((item) => item.id === 'old-topic' || item.reason === 'recent_topic_expired'));

console.log('memoryProfileTtl.test.js passed');
