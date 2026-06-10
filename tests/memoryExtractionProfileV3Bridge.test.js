const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-extract-profile-v3-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'false';
process.env.MEMORY_RAG_ENABLED = 'false';
process.env.MEMORY_EXTRACT_MIN_CONFIDENCE = '0.7';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const parserPath = require.resolve('../api/parser');
require.cache[parserPath] = {
  exports: {
    extractMessageContent: () => ({
      content: JSON.stringify({
        identities: ['明确身份'],
        likes: ['一次性偏好'],
        topics: ['一次性话题'],
        confidence: 0.9
      })
    }),
    extractJsonSafely: (text) => JSON.parse(text)
  }
};

const httpClientPath = require.resolve('../api/httpClient');
require.cache[httpClientPath] = {
  exports: {
    postWithRetry: async () => ({})
  }
};

const { learnSomethingNew } = require('../api/memoryExtraction');
const { loadMemoryEvents } = require('../utils/memory-v3/events');
const { getUserProfile } = require('../utils/memory');

module.exports = (async () => {
  await learnSomethingNew('u_extract_profile', '我喜欢这首歌', '记住了', {
    sessionKey: 'direct:u_extract_profile',
    sessionId: 's1',
    postReplyMemoryMode: 'core',
    throwOnError: true
  });

  const profile = getUserProfile('u_extract_profile');
  assert.ok(!profile.identities.includes('明确身份'));
  assert.ok(!profile.likes.includes('一次性偏好'));
  assert.ok(!profile.recent_topics.includes('一次性话题'));

  const events = loadMemoryEvents();
  assert.ok(events.some((event) => event.semanticSlot === 'identity' && event.text === '明确身份'));
  assert.ok(events.some((event) => event.semanticSlot === 'preference_like' && event.text === '一次性偏好'));
  assert.ok(events.some((event) => event.semanticSlot === 'topic' && event.text === '一次性话题'));

  console.log('memoryExtractionProfileV3Bridge.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
