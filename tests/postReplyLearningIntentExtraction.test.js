const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-intent-extract-'));
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

let modelCalls = 0;
const parserPath = require.resolve('../api/parser');
require.cache[parserPath] = {
  exports: {
    extractMessageContent: () => ({ content: JSON.stringify({ facts: ['不应该写入'], confidence: 0.99 }) }),
    extractJsonSafely: (text) => JSON.parse(text)
  }
};

const httpClientPath = require.resolve('../api/httpClient');
require.cache[httpClientPath] = {
  exports: {
    postWithRetry: async () => {
      modelCalls += 1;
      return {};
    }
  }
};

const { learnSomethingNew } = require('../api/memoryExtraction');
const { loadMemoryEvents } = require('../utils/memory-v3/events');

module.exports = (async () => {
  await learnSomethingNew('u_intent_extract', '普通聊天不该强画像', '嗯嗯', {
    sessionKey: 's1',
    sessionId: 's1',
    postReplyMemoryMode: 'core',
    learningIntent: 'implicit',
    throwOnError: true
  });
  assert.strictEqual(modelCalls, 0, 'implicit post-reply core learning should skip profile extractor LLM');

  await learnSomethingNew('u_intent_extract', '记住我喜欢明确保存', '记住了', {
    sessionKey: 's2',
    sessionId: 's2',
    postReplyMemoryMode: 'core',
    learningIntent: 'explicit',
    throwOnError: true
  });
  assert.ok(modelCalls > 0, 'explicit post-reply learning may still run extractor/backfill after explicit capture');
  const explicit = loadMemoryEvents().find((event) => event.sourceKind === 'explicit' && event.text.includes('喜欢明确保存'));
  assert.ok(explicit, 'explicit remember should be persisted before extractor');

  console.log('postReplyLearningIntentExtraction.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
