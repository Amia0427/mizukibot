const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://superapi.buzz/v1/chat/completions';
    process.env.AI_MODEL = 'claude-opus-4-6';
    process.env.MODEL_HTTP_USER_AGENT = 'test-agent';
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

    const request = buildMainModelRequest(null, {
      messages: [
        { role: 'system', content: 'stable persona' },
        { role: 'user', content: 'hello' }
      ],
      stream: false,
      defaultMaxTokens: 200
    });

    assert.strictEqual(request.provider, 'openai_compatible');
    assert.strictEqual(request.url, 'https://superapi.buzz/v1/chat/completions');
    assert.ok(Object.prototype.hasOwnProperty.call(request.body, '__requestHeaders'));
    assert.ok(Object.prototype.hasOwnProperty.call(request.body, 'prompt_cache_key'));

    const prepared = await httpClient.prepareRequest(request.url, request.body);
    assert.strictEqual(prepared.provider, 'openai_compatible');
    assert.strictEqual(prepared.requestUrl, 'https://superapi.buzz/v1/chat/completions');
    assert.ok(Array.isArray(prepared.requestBody.messages));
    assert.ok(prepared.requestBody.messages.some((item) => item.role === 'system' && String(item.content || item.content?.[0]?.text || '').includes('stable persona')));
    assert.ok(Object.prototype.hasOwnProperty.call(prepared.requestHeaders || {}, 'Authorization'));

    console.log('mainClaudeProviderPromotion.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
