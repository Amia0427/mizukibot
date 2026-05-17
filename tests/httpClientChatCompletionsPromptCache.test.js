const assert = require('assert');

module.exports = (async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.OPENAI_MAIN_API_MODE = 'chat_completions';
    const httpClient = require('../api/httpClient');

    const prepared = await httpClient.prepareRequest('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'stable system block',
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

    assert.strictEqual(prepared.provider, 'openai_compatible');
    assert.ok(Array.isArray(prepared.requestBody.messages));
    assert.deepStrictEqual(
      prepared.requestBody.messages[0].content[0].cache_control,
      { type: 'ephemeral', ttl: '5m' }
    );
    assert.deepStrictEqual(
      prepared.requestBody.messages[1].content[0].cache_control,
      { type: 'ephemeral', ttl: '5m' }
    );

    let attemptCount = 0;
    let firstAttemptBody = null;
    let secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('unsupported cache control');
        error.response = {
          status: 400,
          data: { error: { message: 'unknown field cache_control' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok'
              }
            }
          ]
        }
      };
    };

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: prepared.requestBody.messages,
      stream: false
    }, 0, 'test-key');

    assert.strictEqual(attemptCount, 2);
    assert.ok(firstAttemptBody.messages[0].content[0].cache_control);
    assert.ok(!('cache_control' in secondAttemptBody.messages[0].content[0]));
    assert.ok(!('cache_control' in secondAttemptBody.messages[1].content[0]));

    console.log('httpClientChatCompletionsPromptCache.test.js passed');
  } finally {
    axios.post = originalPost;
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
