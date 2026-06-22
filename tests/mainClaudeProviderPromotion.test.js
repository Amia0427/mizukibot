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
    const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.54 Safari/537.36';
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://superapi.buzz/v1/chat/completions';
    process.env.API_PROVIDER = 'anthropic';
    process.env.AI_MODEL = 'claude-opus-4-6';
    process.env.MODEL_HTTP_USER_AGENT = browserUA;
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

    const request = buildMainModelRequest(null, {
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'stable persona', cache_control: true }]
        },
        { role: 'user', content: 'hello' }
      ],
      stream: false,
      defaultMaxTokens: 200
    });

    assert.strictEqual(request.provider, 'anthropic');
    assert.strictEqual(request.url, 'https://superapi.buzz/v1/messages');
    assert.strictEqual(request.body.__requestHeaders['User-Agent'], browserUA);
    assert.strictEqual(request.body.__requestHeaders['x-api-key'], 'main-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(request.body, 'prompt_cache_key'));
    assert.ok(!Array.isArray(request.body.tools));

    const prepared = await httpClient.prepareRequest(request.url, request.body);
    assert.strictEqual(prepared.provider, 'anthropic');
    assert.strictEqual(prepared.requestUrl, 'https://superapi.buzz/v1/messages');
    assert.ok(Array.isArray(prepared.requestBody.messages));
    assert.ok(prepared.requestBody.system.some((item) => String(item.text || '').includes('stable persona')));
    assert.ok(prepared.requestBody.system.some((item) => item.cache_control?.ttl === '5m'));
    assert.ok(prepared.requestBody.messages.every((message) => (
      !Array.isArray(message.content)
      || message.content.every((block) => !block.cache_control || block.cache_control.ttl === '5m')
    )));
    assert.ok(!Array.isArray(prepared.requestBody.tools));
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestBody, 'tool_choice'));
    assert.ok(prepared.requestHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));
    assert.ok(!prepared.requestHeaders['anthropic-beta'].includes('extended-cache-ttl-2025-04-11'));
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestHeaders, 'X-Enable-1h-cache'));
    assert.strictEqual(prepared.requestHeaders['User-Agent'], browserUA);
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestHeaders || {}, 'Authorization'));

    clearProjectCache();
    process.env.API_PROVIDER = 'openai_compatible';
    const { buildMainModelRequest: buildChatMainModelRequest } = require('../api/runtimeV2/model/shared');
    const chatRequest = buildChatMainModelRequest(null, {
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(chatRequest.provider, 'openai_compatible');
    assert.strictEqual(chatRequest.url, 'https://superapi.buzz/v1/chat/completions');
    assert.strictEqual(chatRequest.body.__requestHeaders.Authorization, 'Bearer main-key');
    assert.strictEqual(chatRequest.body.__requestHeaders['User-Agent'], browserUA);

    console.log('mainClaudeProviderPromotion.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
