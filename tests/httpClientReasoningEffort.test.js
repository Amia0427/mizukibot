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
    process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
    process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';
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
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      stream: false
    });
    assert.strictEqual(anthropicPrepared.provider, 'anthropic');
    assert.strictEqual(anthropicPrepared.requestUrl, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(anthropicPrepared.requestBody.max_tokens, 1924);
    assert.deepStrictEqual(anthropicPrepared.requestBody.thinking, {
      type: 'enabled',
      budget_tokens: 1024
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, 'temperature'));
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, 'top_p'));
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, 'top_k'));
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, '__originalMaxTokens'));
    assert.ok(!Object.keys(anthropicPrepared.requestBody).includes('__originalMaxTokens'));

    const anthropicThinkingToolChoicePrepared = await httpClient.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      reasoning_effort: 'high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_memory',
            description: 'lookup',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'lookup_memory' }
      },
      stream: false
    });
    assert.deepStrictEqual(anthropicThinkingToolChoicePrepared.requestBody.thinking, {
      type: 'enabled',
      budget_tokens: 1024
    });
    assert.deepStrictEqual(anthropicThinkingToolChoicePrepared.requestBody.tool_choice, { type: 'auto' });

    const anthropicAdaptivePrepared = await httpClient.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      reasoning_effort: 'high',
      stream: false
    });
    assert.strictEqual(anthropicAdaptivePrepared.provider, 'anthropic');
    assert.deepStrictEqual(anthropicAdaptivePrepared.requestBody.thinking, {
      type: 'enabled',
      budget_tokens: 1024
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicAdaptivePrepared.requestBody, '__originalMaxTokens'));

    process.env.ANTHROPIC_ADAPTIVE_THINKING_ENABLED = 'true';
    clearProjectCache();
    const httpClientWithAdaptiveThinking = require('../api/httpClient');
    const explicitAdaptivePrepared = await httpClientWithAdaptiveThinking.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 900,
      reasoning_effort: 'high',
      stream: false
    });
    assert.deepStrictEqual(explicitAdaptivePrepared.requestBody.thinking, {
      type: 'adaptive'
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(explicitAdaptivePrepared.requestBody.thinking, 'budget_tokens'));
    delete process.env.ANTHROPIC_ADAPTIVE_THINKING_ENABLED;
    clearProjectCache();

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
    assert.strictEqual(firstAttemptBody.max_tokens, 5600);
    assert.deepStrictEqual(firstAttemptBody.thinking, {
      type: 'enabled',
      budget_tokens: 2100
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(firstAttemptBody, '__originalMaxTokens'));
    assert.strictEqual(secondAttemptBody.max_tokens, 3500);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'thinking'));
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, '__originalMaxTokens'));
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    process.env = snapshot;
    clearProjectCache();
  }
})();
