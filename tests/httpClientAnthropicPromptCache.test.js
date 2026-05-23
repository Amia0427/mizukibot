const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function contentParts(item = {}) {
  return Array.isArray(item?.content) ? item.content : [];
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-anthropic-prompt-cache-'));
  let axios = null;
  let originalPost = null;

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ANTHROPIC_BETA = 'tools-2024-04-04';
    clearProjectCache();
    axios = require('axios');
    originalPost = axios.post;

    const httpClient = require('../api/httpClient');
    const {
      listRecentModelCalls,
      flushModelCallLogsSync,
      resetModelCallTracker
    } = require('../utils/modelCallTracker');

    const prepared = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '[Affinity]\nclose friend',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '[Relationship]\ntrusted ally',
              cache_control: true
            }
          ]
        },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '[CurrentConversation]\nlatest turn',
              cache_control: true
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '[Context for assistant only]\nexample few shot',
              cache_control: true
            }
          ]
        },
        {
          role: 'user',
          content: 'hello'
        }
      ],
      stream: false
    });

    assert.strictEqual(prepared.provider, 'anthropic');
    assert.strictEqual(prepared.requestUrl, 'https://example.com/v1/messages');
    assert.ok(Array.isArray(prepared.requestBody.messages));
    const dynamicContext = prepared.requestBody.messages.find((item) => (
      contentParts(item).some((block) => String(block.text || '').includes('[Affinity]'))
    ));
    const relationshipContext = prepared.requestBody.messages.find((item) => (
      contentParts(item).some((block) => String(block.text || '').includes('[Relationship]'))
    ));
    const currentConversationContext = prepared.requestBody.messages.find((item) => (
      contentParts(item).some((block) => String(block.text || '').includes('[CurrentConversation]'))
    ));
    const assistantContext = prepared.requestBody.messages.find((item) => (
      item.role === 'assistant'
      && contentParts(item).some((block) => String(block.text || '').includes('[Context for assistant only]'))
    ));
    assert.ok(dynamicContext);
    assert.ok(relationshipContext);
    assert.ok(currentConversationContext);
    assert.ok(assistantContext);
    assert.ok(!prepared.requestBody.system);
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestBody, 'input'));
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestBody, 'prompt_cache_key'));
    assert.strictEqual(prepared.requestHeaders, null);

    const preparedDynamicOnly = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        {
          role: 'system',
          content: '[Relationship]\ntrusted ally'
        },
        {
          role: 'assistant',
          content: '[Context for assistant only]\nexample few shot'
        },
        {
          role: 'user',
          content: 'hello'
        }
      ],
      stream: false
    });
    assert.ok(!preparedDynamicOnly.requestBody.system || Array.isArray(preparedDynamicOnly.requestBody.system));
    assert.ok(preparedDynamicOnly.requestBody.messages.every((item) => (
      contentParts(item).length === 0
      || contentParts(item).every((block) => block.cache_control?.type === 'ephemeral' || !('cache_control' in block))
    )));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedDynamicOnly.requestBody, 'prompt_cache_key'));

    const preparedStableSystem = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'stable persona',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        },
        {
          role: 'user',
          content: 'dynamic latest turn'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_memory',
            description: 'lookup stable schema',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' }
              }
            }
          }
        }
      ],
      stream: false
    });
    assert.ok(preparedStableSystem.requestBody.system.some((block) => block.cache_control?.type === 'ephemeral'));
    assert.ok(preparedStableSystem.requestBody.tools.some((tool) => tool.cache_control?.type === 'ephemeral'));
    assert.ok(!Object.prototype.hasOwnProperty.call(preparedStableSystem.requestBody, 'prompt_cache_key'));

    let attemptCount = 0;
    let firstAttemptBody = null;
    let secondAttemptBody = null;
    let firstAttemptHeaders = null;
    let secondAttemptHeaders = null;

    axios.post = async (_url, body, options = {}) => {
      if (String(_url || '').includes('/embeddings')) {
        return {
          data: {
            data: (Array.isArray(body?.input) ? body.input : [body?.input]).map(() => ({ embedding: [1, 0, 0] }))
          }
        };
      }
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        firstAttemptHeaders = options.headers;
      } else {
        secondAttemptBody = body;
        secondAttemptHeaders = options.headers;
      }
      return {
        data: {
          type: 'message',
          role: 'assistant',
          model: 'claude-3-5-sonnet-latest',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            cache_read_input_tokens: 16,
            cache_creation_input_tokens: 2
          }
        }
      };
    };

    resetModelCallTracker();
    await httpClient.postWithRetry('https://example.com/v1/messages', {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'stable persona',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '[Relationship]\ntrusted ally',
              cache_control: true
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '[Context for assistant only]\nexample few shot',
              cache_control: true
            }
          ]
        },
        {
          role: 'user',
          content: '继续'
        }
      ],
      stream: false
    }, 0, 'test-key');

    assert.strictEqual(attemptCount, 1);
    assert.ok(firstAttemptBody.system.some((block) => block.cache_control?.type === 'ephemeral'));
    assert.ok(firstAttemptHeaders['x-api-key']);
    assert.ok(firstAttemptHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));
    assert.strictEqual(secondAttemptBody, null);
    assert.strictEqual(secondAttemptHeaders, null);

    const calls = listRecentModelCalls(1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].prompt_caching.openai_prompt_cache_key, '');
    assert.strictEqual(calls[0].usage.cache_read_input_tokens, 16);
    assert.strictEqual(calls[0].usage.cache_creation_input_tokens, 2);
    flushModelCallLogsSync();
    const loggedCalls = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const loggedCall = loggedCalls.find((item) => item.id === calls[0].id);
    assert.ok(loggedCall, 'model call log should include the completed Anthropic prompt cache request');
    assert.strictEqual(loggedCall.prompt_caching.openai_prompt_cache_key, '');
    assert.strictEqual(loggedCall.usage.cache_read_input_tokens, 16);
    assert.strictEqual(loggedCall.usage.cache_creation_input_tokens, 2);

    attemptCount = 0;
    axios.post = async (_url, body, options = {}) => {
      if (String(_url || '').includes('/embeddings')) {
        return {
          data: {
            data: (Array.isArray(body?.input) ? body.input : [body?.input]).map(() => ({ embedding: [1, 0, 0] }))
          }
        };
      }
      attemptCount += 1;
      assert.ok(body.messages.every((item) => (
        contentParts(item).length === 0
        || contentParts(item).every((block) => block.cache_control?.type === 'ephemeral' || !('cache_control' in block))
      )));
      assert.ok(options?.headers?.['x-api-key']);
      const stream = new PassThrough();
      setImmediate(() => {
        stream.write('data: {"type":"response.created","response":{"usage":{"input_tokens":18,"input_tokens_details":{"cached_tokens":12}}}}\n\n');
        stream.write('data: {"type":"response.output_text.delta","delta":"he"}\n\n');
        stream.write('data: {"type":"response.completed","response":{"usage":{"output_tokens":3,"input_tokens_details":{"cached_tokens":12}}}}\n\n');
        stream.write('data: [DONE]\n\n');
        stream.end();
      });
      return { data: stream };
    };

    let streamed = '';
    resetModelCallTracker();
    await httpClient.postStreamWithRetry('https://example.com/v1/messages', {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'stable persona',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '[Affinity]\nclose friend',
              cache_control: true
            }
          ]
        },
        {
          role: 'user',
          content: 'hi'
        }
      ],
      stream: true
    }, {
      onData(chunk) {
        streamed += chunk.toString('utf8');
      }
    }, 0, 'test-key');

    assert.strictEqual(attemptCount, 1);
    assert.ok(streamed.includes('"response.output_text.delta"'));
    const streamedCalls = listRecentModelCalls(1);
    assert.strictEqual(streamedCalls.length, 1);
    assert.strictEqual(streamedCalls[0].usage.prompt_tokens, 18);
    assert.strictEqual(streamedCalls[0].usage.completion_tokens, 3);
    assert.strictEqual(streamedCalls[0].usage.cache_read_input_tokens, 12);

    console.log('httpClientAnthropicPromptCache.test.js passed');
  } finally {
    axios.post = originalPost;
    resetProjectEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function resetProjectEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}
