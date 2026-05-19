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
  let axios = null;
  let originalPost = null;

  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://api.anthropic.com/v1/messages';
    process.env.AI_MODEL = 'claude-3-5-sonnet-latest';
    process.env.MODEL_HTTP_USER_AGENT = 'test-agent';
    process.env.OPENAI_PROMPT_CACHE_ENABLED = 'true';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

    const anthropicMain = buildMainModelRequest(null, {
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(anthropicMain.provider, 'openai_compatible');
    assert.strictEqual(anthropicMain.url, 'https://api.anthropic.com/v1/chat/completions');
    assert.ok(Object.prototype.hasOwnProperty.call(anthropicMain.body, 'prompt_cache_key'));
    assert.strictEqual(anthropicMain.body.prompt_cache_retention, '24h');
    assert.ok(Object.prototype.hasOwnProperty.call(anthropicMain.body, '__requestHeaders'));

    const preparedAnthropic = await httpClient.prepareRequest(anthropicMain.url, anthropicMain.body);
    assert.strictEqual(preparedAnthropic.provider, 'openai_compatible');
    assert.strictEqual(preparedAnthropic.requestUrl, 'https://api.anthropic.com/v1/chat/completions');
    assert.ok(Array.isArray(preparedAnthropic.requestBody.messages));
    assert.strictEqual(preparedAnthropic.requestBody.prompt_cache_key, anthropicMain.body.prompt_cache_key);
    assert.strictEqual(preparedAnthropic.requestBody.prompt_cache_retention, '24h');
    assert.ok(Object.prototype.hasOwnProperty.call(preparedAnthropic.requestHeaders || {}, 'Authorization'));
    assert.strictEqual(preparedAnthropic.requestHeaders['User-Agent'], 'test-agent');

    axios = require('axios');
    originalPost = axios.post;
    let sentAnthropicOptions = null;
    axios.post = async (_url, _body, options = {}) => {
      sentAnthropicOptions = options;
      return { data: { content: [{ type: 'text', text: 'ok' }] }, status: 200 };
    };
    await httpClient.postWithRetry(anthropicMain.url, anthropicMain.body, 0, 'main-key');
    assert.strictEqual(sentAnthropicOptions.headers.Authorization, 'Bearer main-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(sentAnthropicOptions.headers, 'x-api-key'));
    assert.strictEqual(sentAnthropicOptions.headers['User-Agent'], 'test-agent');
    axios.post = originalPost;

    const preparedGeminiNative = await httpClient.prepareRequest(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
      {
        model: 'gemini-3-pro-preview',
        prompt_cache_key: 'openai-cache',
        prompt_cache_retention: '24h',
        cache_control: { type: 'ephemeral', ttl: '5m' },
        __requestHeaders: {
          Authorization: 'Bearer bad',
          'User-Agent': 'bad-agent',
          'x-goog-api-key': 'gemini-key'
        },
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'native text', cache_control: { type: 'ephemeral', ttl: '5m' } },
              { inlineData: { mimeType: 'image/png', data: 'aW1n' }, cache: true }
            ],
            cacheControl: true
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this', cache_control: true },
              { type: 'image_url', image_url: { url: 'cached-image://missing-ref', detail: 'ultra' } }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: { type: 'object', properties: {} },
              cache_control: true
            }
          }
        ],
        stream: false
      }
    );
    assert.strictEqual(preparedGeminiNative.provider, 'gemini_native');
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'prompt_cache_retention'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0], 'cacheControl'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0].parts[0], 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0].parts[1], 'cache'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.messages[0].content[0], 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.tools[0].function, 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestHeaders || {}, 'Authorization'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestHeaders || {}, 'User-Agent'));
    assert.strictEqual(preparedGeminiNative.requestHeaders['x-goog-api-key'], 'gemini-key');

    clearProjectCache();
    const { buildBotDiaryQzoneImageHeaders } = require('../api/imageGeneration');
    const geminiImageHeaders = buildBotDiaryQzoneImageHeaders(
      'gemini-image-key',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent'
    );
    assert.strictEqual(geminiImageHeaders['x-goog-api-key'], 'gemini-image-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(geminiImageHeaders, 'Authorization'));
    assert.strictEqual(geminiImageHeaders['User-Agent'], false);

    const { drawBotDiaryQzonePicture } = require('../api/imageGeneration');
    let sentImageOptions = null;
    const generatedImage = await drawBotDiaryQzonePicture('draw a cat', {
      buildProviderConfig: () => ({
        enabled: true,
        model: 'gemini-3-pro-preview',
        apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-image-key'
      }),
      httpClient: {
        async post(_url, _body, options = {}) {
          sentImageOptions = options;
          return {
            data: {
              candidates: [
                {
                  content: {
                    parts: [
                      { inlineData: { mimeType: 'image/png', data: 'aW1n' } }
                    ]
                  }
                }
              ]
            }
          };
        }
      }
    });
    assert.strictEqual(generatedImage, 'data:image/png;base64,aW1n');
    assert.strictEqual(sentImageOptions.headers['x-goog-api-key'], 'gemini-image-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(sentImageOptions.headers, 'Authorization'));
    assert.strictEqual(sentImageOptions.headers['User-Agent'], false);

    const openAIImageHeaders = buildBotDiaryQzoneImageHeaders(
      'openai-image-key',
      'https://example.com/v1/images/generations'
    );
    assert.strictEqual(openAIImageHeaders.Authorization, 'Bearer openai-image-key');
    assert.strictEqual(openAIImageHeaders['User-Agent'], 'test-agent');
    assert.ok(!Object.prototype.hasOwnProperty.call(openAIImageHeaders, 'x-goog-api-key'));

    delete process.env.MODEL_HTTP_USER_AGENT;
    delete process.env.MAIN_REPLY_USER_AGENT;
    delete process.env.HTTP_USER_AGENT;
    clearProjectCache();
    const defaultConfig = require('../config');
    assert.strictEqual(defaultConfig.MODEL_HTTP_USER_AGENT, 'claude-cli/2.0.76 (external, cli)');

    console.log('providerRequestNormalization.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
