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
  let nonStreamingContent = '非流式正文';
  let nonStreamingReasoning = '非流式显式 reasoning';
  let streamingChunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"流式 reasoning 1"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":" + 2"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"流式正文"}}]}\n\n'
  ];
  httpClient.postWithRetry = async () => ({
    status: 200,
    data: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: nonStreamingContent,
            reasoning_content: nonStreamingReasoning
          }
        }
      ]
    }
  });
  httpClient.postStreamWithRetry = async (_url, _body, callbacks) => {
    for (const chunk of streamingChunks) callbacks.onData(Buffer.from(chunk));
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

  nonStreamingContent = '■ Two pigs, one shoving the other. Reply as Mizuki, 1:45am, casual, no brackets, no emoji, short chunks. --- 哈哈哈这个接得太准了吧';
  nonStreamingReasoning = '上游独立 reasoning';
  const isolatedPreamble = await service.requestNonStreamingReply([{ role: 'user', content: 'mixed content' }], {
    modelConfig: {
      apiBaseUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'claude-test',
      provider: 'openai_compatible'
    }
  });
  assert.strictEqual(isolatedPreamble.visibleText, '哈哈哈这个接得太准了吧');
  assert.strictEqual(isolatedPreamble.persistedText, '哈哈哈这个接得太准了吧');
  assert.strictEqual(
    isolatedPreamble.reasoningText,
    '上游独立 reasoning\n\n■ Two pigs, one shoving the other.'
  );

  nonStreamingContent = '（心想：不进入非流式正文。）非流式安全正文';
  nonStreamingReasoning = '';
  const sanitizedNonStreaming = await service.requestNonStreamingReply([{ role: 'user', content: 'hi again' }], {
    modelConfig: {
      apiBaseUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'claude-test',
      provider: 'openai_compatible'
    }
  });
  assert.strictEqual(sanitizedNonStreaming.visibleText, '非流式安全正文');
  assert.strictEqual(sanitizedNonStreaming.persistedText, '非流式安全正文');

  streamingChunks = [
    'data: {"choices":[{"delta":{"content":"（心想：不"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"进入流式正文。）"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"流式安全正文"}}]}\n\n'
  ];
  const visibleDeltas = [];
  const sanitizedStreaming = await service.requestStreamingReply([{ role: 'user', content: 'hi again' }], {
    onDelta(delta) {
      visibleDeltas.push(delta);
    },
    modelConfig: {
      apiBaseUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'claude-test',
      provider: 'openai_compatible'
    }
  }, {
    apiBaseUrl: 'https://example.com/v1/chat/completions',
    apiKey: 'test',
    model: 'claude-test',
    provider: 'openai_compatible'
  });
  assert.strictEqual(sanitizedStreaming.visibleText, '流式安全正文');
  assert.strictEqual(sanitizedStreaming.persistedText, '流式安全正文');
  assert.deepStrictEqual(visibleDeltas, ['流式安全正文']);

  console.log('modelServiceReasoning.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
