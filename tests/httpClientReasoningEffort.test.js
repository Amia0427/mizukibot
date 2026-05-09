const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  let axios = null;
  let originalPost = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    clearProjectCache();
    axios = require('axios');
    originalPost = axios.post;
    const httpClient = require('../api/httpClient');

    const openaiPrepared = await httpClient.prepareRequest('https://example.com/v1/chat/completions', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      reasoning_effort: 'HIGH',
      stream: false
    });
    assert.strictEqual(openaiPrepared.provider, 'openai_compatible');
    assert.strictEqual(openaiPrepared.requestBody.reasoning_effort, 'high');

    const tracedPrepared = await httpClient.prepareRequest('https://example.com/v1/chat/completions', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      stream: false,
      __trace: {
        source: 'test',
        userId: 'u1'
      },
      __timeoutMs: 1234
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(tracedPrepared.requestBody, '__trace'));
    assert.ok(!Object.prototype.hasOwnProperty.call(tracedPrepared.requestBody, '__timeoutMs'));

    const disabledPrepared = await httpClient.prepareRequest('https://example.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      reasoning_effort: 'off',
      stream: false
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(disabledPrepared.requestBody, 'reasoning_effort'));

    const anthropicPrepared = await httpClient.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      reasoning_effort: 'high',
      stream: false
    });
    assert.strictEqual(anthropicPrepared.provider, 'anthropic');
    assert.strictEqual(anthropicPrepared.requestBody.max_tokens, 1924);
    assert.deepStrictEqual(anthropicPrepared.requestBody.thinking, {
      type: 'enabled',
      budget_tokens: 1024
    });

    let attemptCount = 0;
    let firstAttemptBody = null;
    let secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('unsupported reasoning_effort');
        error.response = {
          status: 400,
          data: { error: { message: 'Unknown field reasoning_effort' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      return { data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
    };

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      reasoning_effort: 'high',
      stream: false
    }, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.reasoning_effort, 'high');
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'reasoning_effort'));

    attemptCount = 0;
    firstAttemptBody = null;
    secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('unsupported thinking');
        error.response = {
          status: 400,
          data: { error: { message: 'Unknown field thinking' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      return {
        data: {
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }]
        }
      };
    };

    await httpClient.postWithRetry('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      reasoning_effort: 'high',
      stream: false
    }, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.max_tokens, 5600);
    assert.deepStrictEqual(firstAttemptBody.thinking, {
      type: 'enabled',
      budget_tokens: 2100
    });
    assert.strictEqual(secondAttemptBody.max_tokens, 3500);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'thinking'));
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    process.env = snapshot;
    clearProjectCache();
  }
})();
