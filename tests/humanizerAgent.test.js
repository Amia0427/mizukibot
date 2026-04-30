const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function sse(delta = '') {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

module.exports = (async () => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://main.example/v1';
    process.env.AI_MODEL = 'main-model';
    process.env.HUMANIZER_AGENT_ENABLED = 'true';
    process.env.HUMANIZER_AGENT_API_BASE_URL = 'https://humanizer.example/v1';
    process.env.HUMANIZER_AGENT_API_KEY = 'humanizer-key';
    process.env.HUMANIZER_AGENT_MODEL = 'humanizer-model';
    process.env.HUMANIZER_AGENT_FIRST_TOKEN_TIMEOUT_MS = '10000';

    clearProjectCache();
    const humanizer = require('../api/humanizerAgent');

    const resolved = humanizer.resolveHumanizerModelConfig();
    assert.strictEqual(resolved.apiBaseUrl, 'https://humanizer.example/v1/chat/completions');
    assert.strictEqual(resolved.apiKey, 'humanizer-key');
    assert.strictEqual(resolved.model, 'humanizer-model');
    assert.strictEqual(resolved.apiBaseUrlSource, 'HUMANIZER_AGENT_API_BASE_URL');
    assert.strictEqual(resolved.apiKeySource, 'HUMANIZER_AGENT_API_KEY');
    assert.strictEqual(resolved.modelSource, 'HUMANIZER_AGENT_MODEL');
    assert.strictEqual(humanizer.getHumanizerFirstTokenTimeoutMs(), 10000);

    const deltas = [];
    const fullTexts = [];
    const streamed = await humanizer.runHumanizerAgent('原文', {
      stream: true,
      onDelta(delta, fullText) {
        deltas.push(delta);
        fullTexts.push(fullText);
      },
      firstTokenTimeoutMs: 1000,
      postStreamWithRetryImpl: async (_url, _body, handlers) => {
        handlers.onData(sse('第一段。'));
        handlers.onData(sse('\n\n第二段。'));
      }
    });
    assert.strictEqual(streamed, '第一段。\n\n第二段。');
    assert.deepStrictEqual(fullTexts, ['第一段。', '第一段。\n\n第二段。']);
    assert.deepStrictEqual(deltas, ['第一段。', '\n\n第二段。']);

    const slowAfterFirstTokenDeltas = [];
    const slowAfterFirstToken = await humanizer.runHumanizerAgent('原文', {
      stream: true,
      onDelta(delta, fullText) {
        slowAfterFirstTokenDeltas.push({ delta, fullText });
      },
      firstTokenTimeoutMs: 1,
      postStreamWithRetryImpl: async (_url, _body, handlers) => {
        handlers.onData(sse('先'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        handlers.onData(sse('这样。'));
      }
    });
    assert.strictEqual(slowAfterFirstToken, '先这样。');
    assert.deepStrictEqual(slowAfterFirstTokenDeltas, [{ delta: '先这样。', fullText: '先这样。' }]);

    let timeoutSignal = null;
    await assert.rejects(
      () => humanizer.runHumanizerAgent('原文', {
        stream: true,
        onDelta() {
          throw new Error('timeout path must not emit');
        },
        firstTokenTimeoutMs: 1,
        postStreamWithRetryImpl: async (_url, body) => {
          timeoutSignal = body.__abortSignal;
          await new Promise((resolve) => setTimeout(resolve, 20));
          const error = new Error('aborted by test');
          error.code = 'ERR_CANCELED';
          throw error;
        }
      }),
      (error) => {
        assert.strictEqual(error.code, 'HUMANIZER_FIRST_TOKEN_TIMEOUT');
        assert.strictEqual(error.reason, 'humanizer_first_token_timeout');
        assert.strictEqual(error.humanizerFirstTokenTimeout, true);
        return true;
      }
    );
    assert.ok(timeoutSignal && timeoutSignal.aborted, 'timeout should abort humanizer stream');

    console.log('humanizerAgent.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
