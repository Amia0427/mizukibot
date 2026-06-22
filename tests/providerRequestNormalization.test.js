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
  const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.54 Safari/537.36';

  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://api.anthropic.com/v1/messages';
    process.env.API_PROVIDER = 'anthropic';
    process.env.AI_MODEL = 'claude-3-5-sonnet-latest';
    process.env.MODEL_HTTP_USER_AGENT = browserUA;
    process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
    process.env.OPENAI_PROMPT_CACHE_ENABLED = 'true';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    process.env.GEMINI_SYSTEM_PROMPT_PATH = path.join(__dirname, 'fixtures', 'gemini-system-prompt.txt');
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const { ensureAnthropicMessagesUrl } = require('../utils/modelProvider');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');

    const anthropicMain = buildMainModelRequest(null, {
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(anthropicMain.provider, 'anthropic');
    assert.strictEqual(anthropicMain.url, 'https://api.anthropic.com/v1/messages');
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicMain.body, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicMain.body, 'prompt_cache_retention'));
    assert.strictEqual(anthropicMain.body.__requestHeaders['User-Agent'], browserUA);
    assert.strictEqual(anthropicMain.body.__requestHeaders['x-api-key'], 'main-key');
    assert.strictEqual(anthropicMain.body.__requestHeaders['Sec-Fetch-Mode'], 'cors');

    assert.throws(
      () => buildMainModelRequest(null, {
        messages: [{ role: 'user', content: 'x'.repeat(404000) }],
        stream: false
      }),
      (error) => error && error.code === 'MAIN_REPLY_INPUT_TOKEN_BUDGET_EXCEEDED'
    );

    const preparedAnthropic = await httpClient.prepareRequest(anthropicMain.url, anthropicMain.body);
    assert.strictEqual(preparedAnthropic.provider, 'anthropic');
    assert.strictEqual(preparedAnthropic.requestUrl, 'https://api.anthropic.com/v1/messages');
    assert.ok(Array.isArray(preparedAnthropic.requestBody.messages));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedAnthropic.requestBody, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedAnthropic.requestBody, 'prompt_cache_retention'));
    assert.strictEqual(preparedAnthropic.requestBody.messages[0].content[0].cache_control?.ttl, '5m');
    assert.ok(preparedAnthropic.requestHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));
    assert.ok(!preparedAnthropic.requestHeaders['anthropic-beta'].includes('extended-cache-ttl-2025-04-11'));
    assert.strictEqual(preparedAnthropic.requestHeaders['X-Enable-1h-cache'], '1');
    assert.strictEqual(preparedAnthropic.requestHeaders['User-Agent'], browserUA);
    assert.strictEqual(preparedAnthropic.requestHeaders['sec-ch-ua-platform'], '"Windows"');
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedAnthropic.requestHeaders || {}, 'Authorization'));

    axios = require('axios');
    originalPost = axios.post;
    let sentAnthropicOptions = null;
    axios.post = async (_url, _body, options = {}) => {
      sentAnthropicOptions = options;
      return { data: { content: [{ type: 'text', text: 'ok' }] }, status: 200 };
    };
    await httpClient.postWithRetry(anthropicMain.url, anthropicMain.body, 0, 'main-key');
    assert.strictEqual(sentAnthropicOptions.headers['x-api-key'], 'main-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(sentAnthropicOptions.headers, 'Authorization'));
    assert.strictEqual(sentAnthropicOptions.headers['User-Agent'], browserUA);
    assert.strictEqual(sentAnthropicOptions.headers['Sec-Fetch-Mode'], 'cors');
    axios.post = originalPost;

    const thirdPartyMessagesEndpoint = buildMainModelRequest({
      model: 'claude-3-5-sonnet-latest',
      apiBaseUrl: 'https://third-party.example/v1/messages',
      apiKey: 'third-party-key',
      provider: 'openai_compatible'
    }, {
      messages: [{ role: 'user', content: 'third-party messages' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(thirdPartyMessagesEndpoint.provider, 'anthropic');
    assert.strictEqual(thirdPartyMessagesEndpoint.protocol, 'anthropic_messages');
    assert.strictEqual(thirdPartyMessagesEndpoint.url, 'https://third-party.example/v1/messages');
    assert.strictEqual(thirdPartyMessagesEndpoint.body.__requestHeaders['x-api-key'], 'third-party-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(thirdPartyMessagesEndpoint.body.__requestHeaders, 'Authorization'));
    const preparedThirdPartyMessages = await httpClient.prepareRequest(
      thirdPartyMessagesEndpoint.url,
      thirdPartyMessagesEndpoint.body
    );
    assert.strictEqual(preparedThirdPartyMessages.provider, 'anthropic');
    assert.strictEqual(preparedThirdPartyMessages.requestUrl, 'https://third-party.example/v1/messages');

    const preparedGeminiNative = await httpClient.prepareRequest(
      'https://generativelanguage.googleapis.com/v1beta',
      {
        model: 'gemini-3-pro-preview',
        prompt_cache_key: 'openai-cache',
        prompt_cache_retention: '24h',
        cache_control: { type: 'ephemeral', ttl: '5m' },
        __requestHeaders: {
          Authorization: 'Bearer bad',
          'User-Agent': 'codex-bad-agent',
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
    assert.strictEqual(
      preparedGeminiNative.requestUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent'
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'messages'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'prompt_cache_retention'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody, 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0], 'cacheControl'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0].parts[0], 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestBody.contents[0].parts[1], 'cache'));
    assert.ok(preparedGeminiNative.requestBody.systemInstruction.parts[0].text.includes('[GeminiRuntimeAdapter]'));
    assert.ok(preparedGeminiNative.requestBody.systemInstruction.parts[0].text.includes('fixture gemini prompt'));
    assert.strictEqual(preparedGeminiNative.requestBody.tools[0].functionDeclarations[0].name, 'lookup');
    assert.ok(!Object.prototype.hasOwnProperty.call(
      preparedGeminiNative.requestBody.tools[0].functionDeclarations[0],
      'cache_control'
    ));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNative.requestHeaders || {}, 'Authorization'));
    assert.ok(/^Mozilla\/5\.0/.test(preparedGeminiNative.requestHeaders['User-Agent']));
    const geminiAxiosHeaders = httpClient.getAxiosOptions(
      preparedGeminiNative.provider,
      'gemini-key',
      10000,
      preparedGeminiNative.requestHeaders
    ).headers;
    assert.strictEqual(geminiAxiosHeaders['sec-ch-ua-mobile'], '?0');
    assert.strictEqual(preparedGeminiNative.requestHeaders['x-goog-api-key'], 'gemini-key');

    {
      process.env.ANTHROPIC_PROMPT_CACHE_TTL = '1h';
      clearProjectCache();
      const httpClientWithOneHourAnthropicCache = require('../api/httpClient');
      const preparedOneHourAnthropicCache = await httpClientWithOneHourAnthropicCache.prepareRequest(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'one hour cache ttl override' }],
          stream: false
        }
      );
      assert.strictEqual(preparedOneHourAnthropicCache.requestBody.messages[0].content[0].cache_control?.ttl, '1h');
      assert.ok(preparedOneHourAnthropicCache.requestHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));
      assert.ok(preparedOneHourAnthropicCache.requestHeaders['anthropic-beta'].includes('extended-cache-ttl-2025-04-11'));
      assert.strictEqual(preparedOneHourAnthropicCache.requestHeaders['X-Enable-1h-cache'], '1');
      delete process.env.ANTHROPIC_PROMPT_CACHE_TTL;
      clearProjectCache();
    }

    const preparedGeminiNativeStream = await httpClient.prepareRequest(
      'https://generativelanguage.googleapis.com/v1beta',
      {
        model: 'gemini-3-pro-preview',
        messages: [{ role: 'user', content: 'stream me' }],
        stream: true
      }
    );
    assert.strictEqual(
      preparedGeminiNativeStream.requestUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse'
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiNativeStream.requestBody, 'stream'));

    clearProjectCache();
    const { buildBotDiaryQzoneImageHeaders } = require('../api/imageGeneration');
    const geminiImageHeaders = buildBotDiaryQzoneImageHeaders(
      'gemini-image-key',
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini-3-pro-preview'
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
    assert.strictEqual(openAIImageHeaders['User-Agent'], browserUA);
    assert.ok(!Object.prototype.hasOwnProperty.call(openAIImageHeaders, 'x-goog-api-key'));

    const explicitSummaryOpenAI = buildMainModelRequest({
      model: 'summary-model',
      apiBaseUrl: 'https://summary.example/v1/chat/completions',
      apiKey: 'summary-key',
      provider: 'openai_compatible'
    }, {
      messages: [{ role: 'user', content: 'summary' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(explicitSummaryOpenAI.provider, 'openai_compatible');
    assert.strictEqual(explicitSummaryOpenAI.url, 'https://summary.example/v1/chat/completions');
    assert.strictEqual(explicitSummaryOpenAI.body.__requestHeaders.Authorization, 'Bearer summary-key');

    const scopedFcappAnthropic = buildMainModelRequest({
      model: 'claude-opus-4-6',
      apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/chat/completions',
      apiKey: 'fcapp-key',
      provider: 'openai_compatible'
    }, {
      messages: [{ role: 'user', content: 'fcapp endpoint scoped' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(scopedFcappAnthropic.provider, 'anthropic');
    assert.strictEqual(scopedFcappAnthropic.url, 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages');
    assert.strictEqual(scopedFcappAnthropic.body.__requestHeaders['x-api-key'], 'fcapp-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(scopedFcappAnthropic.body.__requestHeaders, 'Authorization'));
    assert.ok(scopedFcappAnthropic.body.__requestHeaders['anthropic-beta'].includes('context-1m-2025-08-07'));
    const preparedScopedFcapp = await httpClient.prepareRequest(scopedFcappAnthropic.url, scopedFcappAnthropic.body);
    assert.strictEqual(preparedScopedFcapp.provider, 'anthropic');
    assert.strictEqual(preparedScopedFcapp.requestUrl, 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages');
    assert.ok(preparedScopedFcapp.requestHeaders['anthropic-beta'].includes('context-1m-2025-08-07'));
    assert.ok(preparedScopedFcapp.requestHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));

    const bareOriginOpenAI = buildMainModelRequest({
      model: 'claude-sonnet-4-6',
      apiBaseUrl: 'https://superapi.buzz/',
      apiKey: 'image-key',
      provider: 'openai_compatible'
    }, {
      messages: [{ role: 'user', content: 'image reply' }],
      stream: true,
      defaultMaxTokens: 200
    });
    assert.strictEqual(bareOriginOpenAI.provider, 'openai_compatible');
    assert.strictEqual(bareOriginOpenAI.url, 'https://superapi.buzz/v1/chat/completions');
    assert.strictEqual(ensureAnthropicMessagesUrl('https://cc-coding.cn'), 'https://cc-coding.cn/v1/messages');
    assert.strictEqual(ensureAnthropicMessagesUrl('https://cc-coding.cn/v1'), 'https://cc-coding.cn/v1/messages');
    assert.strictEqual(
      ensureAnthropicMessagesUrl('https://cc-coding.cn/v1/chat/completions'),
      'https://cc-coding.cn/v1/messages'
    );

    const bareOriginAnthropic = buildMainModelRequest({
      model: 'claude-sonnet-4-6',
      apiBaseUrl: 'https://cc-coding.cn',
      apiKey: 'cc-key',
      provider: 'anthropic'
    }, {
      messages: [{ role: 'user', content: 'anthropic sdk style base url' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(bareOriginAnthropic.provider, 'anthropic');
    assert.strictEqual(bareOriginAnthropic.protocol, 'anthropic_messages');
    assert.strictEqual(bareOriginAnthropic.url, 'https://cc-coding.cn/v1/messages');
    assert.strictEqual(bareOriginAnthropic.body.__requestHeaders['x-api-key'], 'cc-key');
    assert.ok(!Object.prototype.hasOwnProperty.call(bareOriginAnthropic.body.__requestHeaders, 'Authorization'));
    const preparedBareOriginAnthropic = await httpClient.prepareRequest(
      bareOriginAnthropic.url,
      bareOriginAnthropic.body
    );
    assert.strictEqual(preparedBareOriginAnthropic.provider, 'anthropic');
    assert.strictEqual(preparedBareOriginAnthropic.requestUrl, 'https://cc-coding.cn/v1/messages');

    const geminiMain = buildMainModelRequest({
      model: 'gemini-3-pro-preview',
      apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-main-key'
    }, {
      messages: [{ role: 'user', content: 'gemini main' }],
      stream: true,
      defaultMaxTokens: 200
    });
    assert.strictEqual(geminiMain.provider, 'gemini_native');
    assert.strictEqual(geminiMain.protocol, 'gemini_generate_content');
    assert.strictEqual(
      geminiMain.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse'
    );
    assert.strictEqual(geminiMain.body.stream, true);
    assert.strictEqual(geminiMain.body.__provider, 'gemini_native');
    const preparedGeminiMain = await httpClient.prepareRequest(geminiMain.url, geminiMain.body);
    assert.strictEqual(
      preparedGeminiMain.requestUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse'
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedGeminiMain.requestBody, 'stream'));
    assert.strictEqual(preparedGeminiMain.requestBody.contents[0].parts[0].text, 'gemini main');

    const explicitOpenAIWithGeminiModel = buildMainModelRequest({
      model: 'gemini-3-pro-preview',
      apiBaseUrl: 'https://gateway.example/v1/chat/completions',
      apiKey: 'gateway-key',
      provider: 'openai_compatible'
    }, {
      messages: [{ role: 'user', content: 'gateway' }],
      stream: false,
      defaultMaxTokens: 200
    });
    assert.strictEqual(explicitOpenAIWithGeminiModel.provider, 'openai_compatible');
    assert.strictEqual(explicitOpenAIWithGeminiModel.url, 'https://gateway.example/v1/chat/completions');

    delete process.env.MODEL_HTTP_USER_AGENT;
    delete process.env.MAIN_REPLY_USER_AGENT;
    delete process.env.HTTP_USER_AGENT;
    clearProjectCache();
    const defaultConfig = require('../config');
    assert.strictEqual(defaultConfig.MODEL_HTTP_USER_AGENT, browserUA);
    assert.strictEqual(defaultConfig.HTTP_USER_AGENT, 'codex-cli/0.121.0 (external, cli)');

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
