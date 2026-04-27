const assert = require('assert');
const { PassThrough } = require('stream');

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
  let axios = null;
  let originalPost = null;

  try {
    process.env.API_KEY = 'test-key';
    process.env.API_BASE_URL = 'https://example.com/v1/chat/completions';
    process.env.AI_MODEL = 'gpt-5.4-mini';
    process.env.AI_MAX_TOKENS = '200';
    process.env.AI_RETRIES = '0';
    process.env.OPENAI_PROMPT_CACHE_ENABLED = 'true';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '';
    clearProjectCache();

    axios = require('axios');
    originalPost = axios.post;
    const httpClient = require('../api/httpClient');
    const { buildMainModelRequest } = require('../api/runtimeV2/model/shared');
    const parser = require('../api/parser');

    const messages = [
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
    ];
    const tools = [
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
          },
          strict: true,
          cache_control: { type: 'ephemeral', ttl: '5m' }
        }
      }
    ];

    const chatRequest = buildMainModelRequest(null, {
      messages,
      tools,
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    assert.strictEqual(chatRequest.url, 'https://example.com/v1/chat/completions');
    assert.ok(/^mizukibot:main:chat_completions:[a-f0-9]{24}$/.test(chatRequest.body.prompt_cache_key));
    assert.ok(!Object.prototype.hasOwnProperty.call(chatRequest.body, 'prompt_cache_retention'));

    const dynamicChangedRequest = buildMainModelRequest(null, {
      messages: [
        { role: 'system', content: 'different turn-local memory' },
        { role: 'user', content: 'different user text' }
      ],
      tools,
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    assert.strictEqual(dynamicChangedRequest.body.prompt_cache_key, chatRequest.body.prompt_cache_key);

    const { buildSecuritySystemPrompt } = require('../utils/promptSecurity');
    const securityPromptRequest = buildMainModelRequest(null, {
      messages: [
        { role: 'system', content: buildSecuritySystemPrompt() },
        { role: 'user', content: 'hello' }
      ],
      tools,
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    const securityPromptWithDynamicTailRequest = buildMainModelRequest(null, {
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: `${buildSecuritySystemPrompt()}\n[DailyMemory] turn-local memory`
            }
          ]
        },
        { role: 'user', content: 'hello' }
      ],
      tools,
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    assert.notStrictEqual(securityPromptRequest.body.prompt_cache_key, chatRequest.body.prompt_cache_key);
    assert.strictEqual(securityPromptWithDynamicTailRequest.body.prompt_cache_key, securityPromptRequest.body.prompt_cache_key);

    const preparedChat = await httpClient.prepareRequest(chatRequest.url, chatRequest.body);
    assert.strictEqual(preparedChat.provider, 'openai_compatible');
    assert.strictEqual(preparedChat.requestBody.prompt_cache_key, chatRequest.body.prompt_cache_key);
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedChat.requestBody, 'prompt_cache_retention'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedChat.requestBody.messages[0].content[0], 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedChat.requestBody.tools[0].function, 'cache_control'));

    process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX = 'tenant-user-session-secret';
    clearProjectCache();
    const { buildMainModelRequest: buildMainModelRequestCustomPrefix } = require('../api/runtimeV2/model/shared');
    const customPrefixRequest = buildMainModelRequestCustomPrefix(null, {
      messages,
      tools,
      stream: false,
      defaultMaxTokens: 200
    });
    assert.ok(/^mizukibot:main:chat_completions:[a-f0-9]{24}$/.test(customPrefixRequest.body.prompt_cache_key));
    assert.ok(!customPrefixRequest.body.prompt_cache_key.includes('tenant-user-session-secret'));

    process.env.OPENAI_MAIN_API_MODE = 'responses';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    delete process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX;
    clearProjectCache();
    const httpClientResponses = require('../api/httpClient');
    const { buildMainModelRequest: buildMainModelRequestResponses } = require('../api/runtimeV2/model/shared');
    const responsesRequest = buildMainModelRequestResponses(null, {
      messages: [
        ...messages,
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'lookup_memory',
                arguments: '{"query":"x"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"ok":true}'
        }
      ],
      tools,
      stream: false,
      routeMeta: { topRouteType: 'direct_chat' },
      defaultMaxTokens: 200
    });
    assert.strictEqual(responsesRequest.url, 'https://example.com/v1/responses');
    assert.ok(/^mizukibot:main:responses:[a-f0-9]{24}$/.test(responsesRequest.body.prompt_cache_key));
    assert.strictEqual(responsesRequest.body.prompt_cache_retention, '24h');

    const preparedResponses = await httpClientResponses.prepareRequest(responsesRequest.url, responsesRequest.body);
    assert.strictEqual(preparedResponses.requestUrl, 'https://example.com/v1/responses');
    assert.ok(Array.isArray(preparedResponses.requestBody.input));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedResponses.requestBody, 'messages'));
    assert.strictEqual(preparedResponses.requestBody.max_output_tokens, 200);
    assert.deepStrictEqual(preparedResponses.requestBody.tools[0], {
      type: 'function',
      name: 'lookup_memory',
      parameters: tools[0].function.parameters,
      description: 'search memory',
      strict: true
    });
    assert.ok(preparedResponses.requestBody.input.some((item) => item.type === 'function_call' && item.call_id === 'call_1'));
    assert.ok(preparedResponses.requestBody.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1'));
    assert.strictEqual(preparedResponses.requestBody.prompt_cache_key, responsesRequest.body.prompt_cache_key);
    assert.strictEqual(preparedResponses.requestBody.prompt_cache_retention, '24h');
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedResponses.requestBody.input[0].content[0], 'cache_control'));

    axios = require('axios');
    originalPost = axios.post;
    let attemptCount = 0;
    const bodies = [];
    axios.post = async (_url, body) => {
      bodies.push(body);
      attemptCount += 1;
      if (attemptCount === 1) {
        const error = new Error('unsupported retention');
        error.response = { status: 400, data: { error: { message: 'Unknown parameter prompt_cache_retention' } } };
        throw error;
      }
      return { data: { output_text: 'ok' } };
    };
    await httpClientResponses.postWithRetry(responsesRequest.url, responsesRequest.body, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.ok(bodies[0].prompt_cache_retention);
    assert.ok(bodies[1].prompt_cache_key);
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[1], 'prompt_cache_retention'));

    attemptCount = 0;
    bodies.length = 0;
    axios.post = async (_url, body) => {
      bodies.push(body);
      attemptCount += 1;
      if (attemptCount === 1) {
        const error = new Error('unsupported retention');
        error.response = { status: 400, data: { error: { message: 'Unknown parameter prompt_cache_retention' } } };
        throw error;
      }
      if (attemptCount === 2) {
        const error = new Error('unsupported prompt cache key');
        error.response = { status: 422, data: { error: { message: 'Unknown parameter prompt_cache_key' } } };
        throw error;
      }
      return { data: { output_text: 'ok' } };
    };
    await httpClientResponses.postWithRetry(responsesRequest.url, responsesRequest.body, 0, 'test-key');
    assert.strictEqual(attemptCount, 3);
    assert.ok(bodies[0].prompt_cache_retention);
    assert.ok(bodies[1].prompt_cache_key);
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[1], 'prompt_cache_retention'));
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[2], 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[2], 'prompt_cache_retention'));

    attemptCount = 0;
    bodies.length = 0;
    axios.post = async (_url, body) => {
      bodies.push(body);
      attemptCount += 1;
      if (attemptCount === 1) {
        const error = new Error('unsupported prompt cache key');
        error.response = { status: 422, data: { error: { message: 'Unknown parameter prompt_cache_key' } } };
        throw error;
      }
      return { data: { output_text: 'ok' } };
    };
    await httpClientResponses.postWithRetry(responsesRequest.url, responsesRequest.body, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.ok(bodies[0].prompt_cache_key);
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[1], 'prompt_cache_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(bodies[1], 'prompt_cache_retention'));

    const extracted = parser.extractMessageContent({
      data: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_parser',
            name: 'lookup_memory',
            arguments: '{"query":"parser"}'
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }]
          }
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 64 }
        }
      }
    });
    assert.strictEqual(extracted.content, 'done');
    assert.strictEqual(extracted.tool_calls[0].id, 'call_parser');

    const parsed = parser.extractSSEEvents(
      { buffer: '' },
      'data: {"type":"response.output_text.delta","delta":"he"}\n\n'
      + 'data: {"type":"response.completed","response":{"output_text":"hello","usage":{"input_tokens":12,"output_tokens":2,"input_tokens_details":{"cached_tokens":8}}}}\n\n'
    );
    assert.strictEqual(parsed.events[0].delta, 'he');
    assert.strictEqual(parsed.events[1].usage.cache_read_input_tokens, 8);

    let streamed = '';
    axios.post = async () => {
      const stream = new PassThrough();
      setImmediate(() => {
        stream.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        stream.write('data: [DONE]\n\n');
        stream.end();
      });
      return { data: stream };
    };
    await httpClientResponses.postStreamWithRetry(responsesRequest.url, {
      ...responsesRequest.body,
      stream: true
    }, {
      onData(chunk) {
        streamed += chunk.toString('utf8');
      }
    }, 0, 'test-key');
    assert.ok(streamed.includes('response.output_text.delta'));

    console.log('openAIMainPromptCacheDualProtocol.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
