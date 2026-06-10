const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-extract-class-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'false';
process.env.MEMORY_RAG_ENABLED = 'false';
process.env.MEMORY_EXPLICIT_CAPTURE_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

let parserPayload = {
  likes: ['今天打了 Kitty'],
  topics: ['今天解释钕铜谐音梗'],
  confidence: 0.92
};

const parserPath = require.resolve('../api/parser');
require.cache[parserPath] = {
  exports: {
    extractMessageContent: () => ({ content: JSON.stringify(parserPayload) }),
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
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');

module.exports = (async () => {
  await learnSomethingNew('u_extract_class', '今天打了 Kitty，还聊了钕铜梗', '嗯嗯', {
    sessionKey: 'direct:u_extract_class',
    sessionId: 's1',
    postReplyMemoryMode: 'core',
    throwOnError: true
  });
  let events = loadMemoryEvents();
  const kitty = events.find((event) => event.text === '今天打了 Kitty');
  const meme = events.find((event) => event.text === '今天解释钕铜谐音梗');
  assert.ok(kitty);
  assert.strictEqual(kitty.payload.extractionClass, 'episodic_observation');
  assert.strictEqual(kitty.status, 'candidate');
  assert.ok(meme);
  assert.strictEqual(meme.payload.extractionClass, 'journal_only');

  let profile = materializeMemoryViews({ force: true }).profileProjection.users.u_extract_class;
  assert.ok(!profile.strictProfile.likes.includes('今天打了 Kitty'));
  assert.ok(!profile.weakProfile.single_hit_preferences.includes('今天打了 Kitty'));
  assert.ok(!profile.weakProfile.recent_topics.includes('今天解释钕铜谐音梗'));

  parserPayload = { confidence: 0.1 };
  await learnSomethingNew('u_extract_class', '记住我喜欢稳定画像测试', '记住了', {
    sessionKey: 'direct:u_extract_class',
    sessionId: 's2',
    postReplyMemoryMode: 'core',
    throwOnError: true
  });
  events = loadMemoryEvents();
  const explicit = events.find((event) => event.text.includes('喜欢稳定画像测试') && event.sourceKind === 'explicit');
  assert.ok(explicit);
  assert.strictEqual(explicit.payload.extractionClass, 'stable_profile_candidate');
  assert.strictEqual(explicit.status, 'active');

  profile = materializeMemoryViews({ force: true }).profileProjection.users.u_extract_class;
  assert.ok(profile.strictProfile.likes.some((item) => item.includes('喜欢稳定画像测试')));

  console.log('memoryExtractionProfileClassification.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
