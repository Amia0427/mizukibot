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
    assert.strictEqual(prepared.requestUrl, 'https://example.com/v1/responses');
    assert.ok(Array.isArray(prepared.requestBody.input));
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestBody.input[0].content[0], 'cache_control'));
    assert.ok(!Object.prototype.hasOwnProperty.call(prepared.requestBody.input[1].content[0], 'cache_control'));

    let attemptCount = 0;
    let firstAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      firstAttemptBody = body;
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
      input: prepared.requestBody.input,
      stream: false
    }, 0, 'test-key');

    assert.strictEqual(attemptCount, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(firstAttemptBody.input[0].content[0], 'cache_control'));
    assert.ok(!('cache_control' in firstAttemptBody.input[1].content[0]));

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
