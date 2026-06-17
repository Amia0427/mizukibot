const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  clearProjectCache();
  const httpClient = require('../api/httpClient');
  httpClient.postWithRetry = async () => ({
    status: 200,
    data: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '非流式正文',
            reasoning_content: '非流式显式 reasoning'
          }
        }
      ]
    }
  });
  httpClient.postStreamWithRetry = async (_url, _body, callbacks) => {
    callbacks.onData(Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"流式 reasoning 1"}}]}\n\n'));
    callbacks.onData(Buffer.from('data: {"choices":[{"delta":{"reasoning":" + 2"}}]}\n\n'));
    callbacks.onData(Buffer.from('data: {"choices":[{"delta":{"content":"流式正文"}}]}\n\n'));
  };

  const service = require('../api/runtimeV2/model/service');

  const nonStreaming = await service.requestNonStreamingReply([{ role: 'user', content: 'hi' }], {
    modelConfig: {
      apiBaseUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'claude-test',
      provider: 'openai'
    }
  });
  assert.strictEqual(nonStreaming.visibleText, '非流式正文');
  assert.strictEqual(nonStreaming.persistedText, '非流式正文');
  assert.strictEqual(nonStreaming.reasoningText, '非流式显式 reasoning');

  const streaming = await service.requestStreamingReply([{ role: 'user', content: 'hi' }], {
    modelConfig: {
      apiBaseUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'claude-test',
      provider: 'openai'
    }
  }, {
    apiBaseUrl: 'https://example.com/v1/chat/completions',
    apiKey: 'test',
    model: 'claude-test',
    provider: 'openai'
  });
  assert.strictEqual(streaming.visibleText, '流式正文');
  assert.strictEqual(streaming.persistedText, '流式正文');
  assert.strictEqual(streaming.reasoningText, '流式 reasoning 1 + 2');

  console.log('modelServiceReasoning.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
