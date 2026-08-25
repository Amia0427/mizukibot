'use strict';

const assert = require('assert');

module.exports = (async () => {
  const { createCompanionVoiceClient, createCompanionVoiceService } = require('../src/features/companion-voice');

  const requests = [];
  const client = createCompanionVoiceClient({
    apiUrl: 'https://voice.example/v1/audio/speech',
    apiKey: 'voice-key',
    model: 'tts-model',
    voice: 'mizuki',
    speed: 1.05,
    timeoutMs: 9000,
    request: async (url, body, options) => {
      requests.push({ url, body, options });
      return { data: Buffer.from('mp3-audio') };
    }
  });

  const audio = await client.synthesize('晚安，今天辛苦了。');
  assert.deepStrictEqual(audio, Buffer.from('mp3-audio'));
  assert.deepStrictEqual(requests[0], {
    url: 'https://voice.example/v1/audio/speech',
    body: {
      model: 'tts-model',
      voice: 'mizuki',
      input: '晚安，今天辛苦了。',
      response_format: 'mp3',
      speed: 1.05
    },
    options: {
      headers: {
        Authorization: 'Bearer voice-key',
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: 9000
    }
  });

  const sends = [];
  const service = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: true, COMPANION_VOICE_MAX_CHARS: 300 },
    client,
    sendPrivateVoiceMessage: async (userId, voiceAudio) => {
      sends.push({ userId, voiceAudio });
    }
  });
  const sent = await service.reply('user-a', '晚安，今天辛苦了。');
  assert.deepStrictEqual(sent, {
    sent: true,
    fallbackText: '晚安，今天辛苦了。',
    reason: 'voice_sent'
  });
  assert.strictEqual(sends[0].userId, 'user-a');
  assert.deepStrictEqual(sends[0].voiceAudio, Buffer.from('mp3-audio'));

  const disabled = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: false, COMPANION_VOICE_MAX_CHARS: 300 },
    client,
    sendPrivateVoiceMessage: async () => assert.fail('disabled voice must not send')
  });
  assert.deepStrictEqual(await disabled.reply('user-a', '改用文字'), {
    sent: false,
    fallbackText: '改用文字',
    reason: 'disabled'
  });

  const failed = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: true, COMPANION_VOICE_MAX_CHARS: 300 },
    client: { synthesize: async () => { throw new Error('tts unavailable'); } },
    sendPrivateVoiceMessage: async () => assert.fail('failed synthesis must not send')
  });
  assert.deepStrictEqual(await failed.reply('user-a', '失败后保留文字'), {
    sent: false,
    fallbackText: '失败后保留文字',
    reason: 'tts_failed'
  });

  const sendFailed = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: true, COMPANION_VOICE_MAX_CHARS: 300 },
    client,
    sendPrivateVoiceMessage: async () => { throw new Error('napcat offline'); }
  });
  assert.deepStrictEqual(await sendFailed.reply('user-a', '发送失败也保留文字'), {
    sent: false,
    fallbackText: '发送失败也保留文字',
    reason: 'send_failed'
  });

  await assert.rejects(service.reply('user-a', 'x'.repeat(301)), /voice text too long/);
  console.log('companionVoice.test.js passed');
})();
