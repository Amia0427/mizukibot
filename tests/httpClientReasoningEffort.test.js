const assert = require('assert');
const { Readable } = require('stream');

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
    process.env.MODEL_TOP_P_ENABLED = 'true';
    process.env.OPENAI_MAIN_API_MODE = 'chat_completions';
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
    assert.strictEqual(openaiPrepared.requestUrl, 'https://example.com/v1/responses');
    assert.deepStrictEqual(openaiPrepared.requestBody.reasoning, { effort: 'high' });

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
    assert.strictEqual(tracedPrepared.requestUrl, 'https://example.com/v1/responses');

    const disabledPrepared = await httpClient.prepareRequest('https://example.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      reasoning_effort: 'off',
      stream: false
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(disabledPrepared.requestBody, 'reasoning'));

    const anthropicPrepared = await httpClient.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      reasoning_effort: 'high',
      stream: false
    });
    assert.strictEqual(anthropicPrepared.provider, 'openai_compatible');
    assert.strictEqual(anthropicPrepared.requestUrl, 'https://api.anthropic.com/v1/responses');
    assert.strictEqual(anthropicPrepared.requestBody.max_output_tokens, 900);
    assert.deepStrictEqual(anthropicPrepared.requestBody.reasoning, { effort: 'high' });

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
    assert.deepStrictEqual(firstAttemptBody.reasoning, { effort: 'high' });
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'reasoning'));

    attemptCount = 0;
    firstAttemptBody = null;
    secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('temperature is deprecated');
        error.response = {
          status: 400,
          data: { error: { message: '`temperature` is deprecated for this model' } }
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
      temperature: 0.7,
      stream: false
    }, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.temperature, 0.7);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'temperature'));

    attemptCount = 0;
    firstAttemptBody = null;
    secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('temperature and top_p conflict');
        error.response = {
          status: 400,
          data: { error: { message: '`temperature` and `top_p` cannot both be specified for this model. Please use only one.' } }
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
      temperature: 0.7,
      top_p: 0.9,
      stream: false
    }, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.temperature, 0.7);
    assert.strictEqual(firstAttemptBody.top_p, 0.9);
    assert.strictEqual(secondAttemptBody.temperature, 0.7);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'top_p'));

    attemptCount = 0;
    firstAttemptBody = null;
    secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('temperature is deprecated');
        error.response = {
          status: 400,
          data: { error: { message: '`temperature` is deprecated for this model' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      return {
        status: 200,
        data: Readable.from(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
      };
    };

    await httpClient.postStreamWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      temperature: 0.7,
      stream: true
    }, {}, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.temperature, 0.7);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'temperature'));

    attemptCount = 0;
    firstAttemptBody = null;
    secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        const error = new Error('temperature and top_p conflict');
        error.response = {
          status: 400,
          data: { error: { message: '`temperature` and `top_p` cannot both be specified for this model. Please use only one.' } }
        };
        throw error;
      }
      secondAttemptBody = body;
      return {
        status: 200,
        data: Readable.from(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
      };
    };

    await httpClient.postStreamWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3500,
      temperature: 0.7,
      top_p: 0.9,
      stream: true
    }, {}, 0, 'test-key');
    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.temperature, 0.7);
    assert.strictEqual(firstAttemptBody.top_p, 0.9);
    assert.strictEqual(secondAttemptBody.temperature, 0.7);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'top_p'));

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
    assert.strictEqual(firstAttemptBody.max_output_tokens, 3500);
    assert.deepStrictEqual(firstAttemptBody.reasoning, { effort: 'high' });
    assert.strictEqual(secondAttemptBody.max_output_tokens, 3500);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'reasoning'));
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    process.env = snapshot;
    clearProjectCache();
  }
})();
