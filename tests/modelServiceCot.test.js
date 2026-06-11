const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}waifu${path.sep}`)) {
      delete require.cache[key];
    }
  }
}

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-model-service-cot-'));
  process.env.DATA_DIR = tempDir;
  clearProjectCache();

  const {
    buildReplyTextVariants,
    finalizeReplyText,
    requestAssistantMessage
  } = require('../api/runtimeV2/model/service');
  const {
    flushModelCallLogsSync
  } = require('../utils/modelCallTracker');

  const raw = '答复前<think>内部推理</think>答复后';
  const rawThinking = '答复前<thinking>内部推理</thinking>答复后';
  const variants = buildReplyTextVariants(raw, '', { preserveThink: true });
  assert.strictEqual(variants.visibleText, raw);
  assert.strictEqual(variants.persistedText, '答复前答复后');
  const thinkingVariants = buildReplyTextVariants(rawThinking, '', { preserveThink: true });
  assert.strictEqual(thinkingVariants.visibleText, rawThinking);
  assert.strictEqual(thinkingVariants.persistedText, '答复前答复后');

  const finalized = await finalizeReplyText(raw, '', {
    preserveThink: true,
    disableHumanizer: true
  });
  assert.strictEqual(finalized.visibleText, raw);
  assert.strictEqual(finalized.persistedText, '答复前答复后');
  const finalizedThinking = await finalizeReplyText(rawThinking, '', {
    preserveThink: true,
    disableHumanizer: true
  });
  assert.strictEqual(finalizedThinking.visibleText, rawThinking);
  assert.strictEqual(finalizedThinking.persistedText, '答复前答复后');

  const axios = require('axios');
  const originalPost = axios.post;
  try {
    axios.post = async () => ({ data: { unexpected: true } });
    const malformed = await requestAssistantMessage([
      { role: 'user', content: 'hello' }
    ], {
      modelConfig: {
        model: 'test-model',
        apiBaseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        retries: 0
      }
    });
    assert.strictEqual(malformed.role, 'assistant');
    assert.ok(!String(malformed.content).includes('The model response format was malformed'));
    assert.ok(String(malformed.content).includes('模型返回格式不稳定'));
    flushModelCallLogsSync();
    const rows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const parseFailure = rows.find((row) => row.status === 'parse_failed');
    assert.ok(parseFailure, 'malformed model response should append a parse_failed diagnostic row');
    assert.strictEqual(parseFailure.final_error_code, 'response_parse_empty');
    assert.strictEqual(parseFailure.parse_stage, 'extract_message_content');
    assert.deepStrictEqual(parseFailure.parse_diagnostic.top_level_keys, ['unexpected']);
  } finally {
    axios.post = originalPost;
  }

  console.log('modelServiceCot.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
