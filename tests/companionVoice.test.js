'use strict';

const assert = require('assert');
const { createDeliveryTarget } = require('../src/platforms/contracts');

function target(platform, chatType) {
  return createDeliveryTarget({
    platform,
    chatType,
    containerId: platform === 'discord' ? 'guild-1' : 'bot-1',
    conversationId: `${platform}-${chatType}`,
    externalUserId: 'user-1'
  });
}

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

  const segmented = [];
  const segmentedService = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: true, COMPANION_VOICE_MAX_CHARS: 300, COMPANION_VOICE_MAX_SEGMENTS: 4 },
    provider: {
      configured: true,
      synthesize: async ({ text }) => ({
        buffer: Buffer.from(text),
        mimeType: 'audio/mpeg',
        format: 'mp3',
        fileName: 'voice.mp3'
      })
    },
    canSendAudio: () => true,
    sendAudio: async (_target, audio) => {
      segmented.push(`audio:${audio.buffer.length}`);
      return { status: 'accepted', mode: 'record' };
    },
    sendText: async (_target, text) => {
      segmented.push(`text:${text.length}`);
      return { status: 'accepted', mode: 'record' };
    }
  });
  const segmentedResult = await segmentedService.reply({
    text: 'x'.repeat(1500),
    deliveryTarget: target('qq', 'private')
  });
  assert.strictEqual(segmentedResult.reason, 'partial_text_fallback');
  assert.deepStrictEqual(segmented, ['audio:300', 'audio:300', 'audio:300', 'audio:300', 'text:300']);
  console.log('companionVoice.test.js passed');
})();
