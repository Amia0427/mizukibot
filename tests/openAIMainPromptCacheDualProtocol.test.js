const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
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
    process.env.API_KEY = 'test-key';
    process.env.API_BASE_URL = 'https://example.com/v1/chat/completions';
    process.env.AI_MODEL = 'claude-3-5-sonnet-latest';
    process.env.AI_MAX_TOKENS = '200';
    process.env.AI_RETRIES = '0';
    process.env.OPENAI_MAIN_API_MODE = 'responses';
    process.env.OPENAI_PROMPT_CACHE_ENABLED = 'true';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

    const mainRequest = buildMainModelRequest(null, {
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'stable system prompt',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        },
        { role: 'user', content: 'hello' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_memory',
            description: 'search memory',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' }
              },
              required: ['query']
            }
          }
        }
      ],
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });

    assert.strictEqual(mainRequest.provider, 'anthropic');
    assert.strictEqual(mainRequest.protocol, 'anthropic_messages');
    assert.strictEqual(mainRequest.url, 'https://example.com/v1/messages');
    assert.ok(!Object.prototype.hasOwnProperty.call(mainRequest.body, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mainRequest.body, 'prompt_cache_retention'));

    const preparedMain = await httpClient.prepareRequest(mainRequest.url, mainRequest.body);
    assert.strictEqual(preparedMain.provider, 'anthropic');
    assert.strictEqual(preparedMain.requestUrl, 'https://example.com/v1/messages');
    assert.ok(Array.isArray(preparedMain.requestBody.system));
    assert.ok(preparedMain.requestBody.system.some((block) => block.cache_control?.type === 'ephemeral'));
    assert.ok(preparedMain.requestBody.tools.some((tool) => tool.cache_control?.type === 'ephemeral'));
    assert.strictEqual(preparedMain.requestHeaders['anthropic-beta'], 'prompt-caching-2024-07-31');
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedMain.requestBody, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedMain.requestBody, 'input'));

    process.env.API_BASE_URL = 'https://example.com/v1/responses';
    clearProjectCache();
    const { buildMainModelRequest: buildMainModelRequestFromResponsesUrl } = require('../api/runtimeV2/model/shared');
    const responsesUrlMainRequest = buildMainModelRequestFromResponsesUrl(null, {
      messages: [{ role: 'user', content: 'hello from responses url' }],
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    assert.strictEqual(responsesUrlMainRequest.provider, 'anthropic');
    assert.strictEqual(responsesUrlMainRequest.protocol, 'anthropic_messages');
    assert.strictEqual(responsesUrlMainRequest.url, 'https://example.com/v1/messages');
    assert.ok(!Object.prototype.hasOwnProperty.call(responsesUrlMainRequest.body, 'prompt_cache_key'));

    console.log('openAIMainPromptCacheDualProtocol.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
