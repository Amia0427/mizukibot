const assert = require('assert');
const { PassThrough } = require('stream');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ANTHROPIC_BETA = 'tools-2024-04-04';
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const {
      listRecentModelCalls,
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
    assert.ok(Array.isArray(prepared.requestBody.messages));
    const assistantContext = prepared.requestBody.messages.find((item) => item.role === 'assistant');
    assert.ok(assistantContext);
    assert.deepStrictEqual(
      assistantContext.content[assistantContext.content.length - 1].cache_control,
      { type: 'ephemeral', ttl: '5m' }
    );

    let attemptCount = 0;
    let firstAttemptBody = null;
    let secondAttemptBody = null;
    let firstAttemptHeaders = null;
    let secondAttemptHeaders = null;

    axios.post = async (_url, body, options = {}) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        firstAttemptHeaders = options.headers;
        const error = new Error('unsupported prompt caching');
        error.response = {
          status: 400,
          data: { error: { message: 'unsupported beta anthropic-beta prompt-caching-2024-07-31' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      secondAttemptHeaders = options.headers;
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

    assert.strictEqual(attemptCount, 2);
    assert.ok(firstAttemptBody.messages.some((item) => item.content.some((block) => block.cache_control)));
    assert.ok(firstAttemptHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));
    assert.ok(secondAttemptBody.messages.every((item) => item.content.every((block) => !('cache_control' in block))));
    assert.ok(!String(secondAttemptHeaders['anthropic-beta'] || '').includes('prompt-caching-2024-07-31'));
    assert.ok(String(secondAttemptHeaders['anthropic-beta'] || '').includes('tools-2024-04-04'));

    const calls = listRecentModelCalls(1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].prompt_caching.total_cache_breakpoints, 0);
    assert.strictEqual(calls[0].prompt_caching.prompt_caching_beta_enabled, false);
    assert.strictEqual(calls[0].usage.cache_read_input_tokens, 16);
    assert.strictEqual(calls[0].usage.cache_creation_input_tokens, 2);

    attemptCount = 0;
    axios.post = async (_url, body, options = {}) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        const error = new Error('unsupported prompt caching');
        error.response = {
          status: 422,
          data: { error: { message: 'unknown field cache_control' } }
        };
        throw error;
      }
      assert.ok(body.messages.every((item) => item.content.every((block) => !('cache_control' in block))));
      assert.ok(!String(options?.headers?.['anthropic-beta'] || '').includes('prompt-caching-2024-07-31'));
      const stream = new PassThrough();
      setImmediate(() => {
        stream.write('data: {"type":"message_start","message":{"usage":{"input_tokens":18,"cache_read_input_tokens":12}}}\n\n');
        stream.write('data: {"type":"content_block_start","content_block":{"type":"text","text":"he"}}\n\n');
        stream.write('data: {"type":"message_delta","usage":{"output_tokens":3,"cache_creation_input_tokens":1}}\n\n');
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

    assert.strictEqual(attemptCount, 2);
    assert.ok(streamed.includes('"message_delta"'));
    const streamedCalls = listRecentModelCalls(1);
    assert.strictEqual(streamedCalls.length, 1);
    assert.strictEqual(streamedCalls[0].prompt_caching.total_cache_breakpoints, 0);
    assert.strictEqual(streamedCalls[0].usage.prompt_tokens, 18);
    assert.strictEqual(streamedCalls[0].usage.completion_tokens, 3);
    assert.strictEqual(streamedCalls[0].usage.cache_read_input_tokens, 12);
    assert.strictEqual(streamedCalls[0].usage.cache_creation_input_tokens, 1);

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
