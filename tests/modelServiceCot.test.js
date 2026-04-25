const assert = require('assert');

const {
  buildReplyTextVariants,
  finalizeReplyText,
  requestAssistantMessage
} = require('../api/runtimeV2/model/service');

module.exports = (async () => {
  const raw = '答复前<think>内部推理</think>答复后';
  const variants = buildReplyTextVariants(raw, '', { preserveThink: true });
  assert.strictEqual(variants.visibleText, raw);
  assert.strictEqual(variants.persistedText, '答复前答复后');

  const finalized = await finalizeReplyText(raw, '', {
    preserveThink: true,
    disableHumanizer: true
  });
  assert.strictEqual(finalized.visibleText, raw);
  assert.strictEqual(finalized.persistedText, '答复前答复后');

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
  } finally {
    axios.post = originalPost;
  }

  console.log('modelServiceCot.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
