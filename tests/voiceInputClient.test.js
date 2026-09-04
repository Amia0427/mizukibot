const assert = require('assert');

const { createVoiceInputClient } = require('../src/features/voice-input/client');

module.exports = (async () => {
  const stream = { kind: 'read-stream' };
  let captured;
  const client = createVoiceInputClient({
    apiUrl: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'voice-key',
    model: 'voice-model',
    timeoutMs: 4321,
    createReadStream: (filePath) => {
      assert.strictEqual(filePath, 'voice.mp3');
      return stream;
    },
    request: async (url, body, options) => {
      captured = { url, body, options };
      return { data: { text: '  这是转写结果。  ' } };
    }
  });

  assert.strictEqual(await client.transcribe('voice.mp3'), '这是转写结果。');
  assert.strictEqual(captured.url, 'https://api.example/v1/audio/transcriptions');
  assert.strictEqual(captured.body.model, 'voice-model');
  assert.strictEqual(captured.body.file, stream);
  assert.strictEqual(Buffer.isBuffer(captured.body.file), false);
  assert.strictEqual(captured.body.response_format, 'json');
  assert.strictEqual(captured.options.headers.Authorization, 'Bearer voice-key');
  assert.strictEqual(captured.options.timeout, 4321);

  const emptyClient = createVoiceInputClient({
    apiUrl: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'voice-key',
    model: 'voice-model',
    createReadStream: () => stream,
    request: async () => ({ data: { text: ' ' } })
  });
  await assert.rejects(() => emptyClient.transcribe('voice.mp3'), /empty text/i);

  const failedClient = createVoiceInputClient({
    apiUrl: 'https://api.example/v1/audio/transcriptions',
    apiKey: 'voice-key',
    model: 'voice-model',
    createReadStream: () => stream,
    request: async () => {
      throw new Error('upstream unavailable');
    }
  });
  await assert.rejects(() => failedClient.transcribe('voice.mp3'), /upstream unavailable/);

  console.log('voiceInputClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
