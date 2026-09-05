'use strict';

const assert = require('assert');

const {
  createExternalTtsProvider,
  createLocalTtsProvider,
  createCompanionVoiceService
} = require('../src/features/companion-voice');
const { createDeliveryTarget } = require('../src/platforms/contracts');

function buildTarget(platform, chatType = 'private') {
  return createDeliveryTarget({
    platform,
    chatType,
    containerId: platform === 'discord' ? 'guild-1' : 'bot-1',
    conversationId: `${platform}-${chatType}`,
    externalUserId: 'user-1'
  });
}

module.exports = (async () => {
  let retryAttempts = 0;
  const retryProvider = createExternalTtsProvider({
    apiUrl: 'https://voice.example/speech',
    model: 'tts-model',
    voice: 'coral',
    request: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        const error = new Error('connect refused');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return { data: Buffer.from('mp3'), headers: { 'content-type': 'audio/mpeg' } };
    }
  });
  await retryProvider.synthesize({ text: '只重试一次', format: 'mp3' });
  assert.strictEqual(retryAttempts, 2);

  let permanentAttempts = 0;
  const permanentProvider = createExternalTtsProvider({
    apiUrl: 'https://voice.example/speech',
    model: 'tts-model',
    voice: 'coral',
    request: async () => {
      permanentAttempts += 1;
      const error = new Error('unauthorized');
      error.response = { status: 401 };
      throw error;
    }
  });
  await assert.rejects(permanentProvider.synthesize({ text: '不重试', format: 'mp3' }), /unauthorized/);
  assert.strictEqual(permanentAttempts, 1);

  const invalidLocalProvider = createLocalTtsProvider({
    localApiUrl: 'http://127.0.0.1:18080/tts',
    voice: 'coral',
    request: async () => ({
      data: Buffer.from('{"error":"bad"}'),
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(
    invalidLocalProvider.synthesize({ text: '非音频响应', format: 'mp3' }),
    /local TTS response must be audio/
  );

  let unconfiguredLocalRequests = 0;
  const unconfiguredLocalProvider = createLocalTtsProvider({
    apiUrl: 'https://voice.example/external-speech',
    localApiUrl: '',
    voice: 'coral',
    request: async () => {
      unconfiguredLocalRequests += 1;
      return { data: Buffer.from('must not request'), headers: { 'content-type': 'audio/mpeg' } };
    }
  });
  assert.strictEqual(unconfiguredLocalProvider.configured, false);
  await assert.rejects(
    unconfiguredLocalProvider.synthesize({ text: '本地地址未配置', format: 'mp3' }),
    /local TTS is not configured/
  );
  assert.strictEqual(unconfiguredLocalRequests, 0);

  const audioCalls = [];
  const textCalls = [];
  const service = createCompanionVoiceService({
    config: {
      COMPANION_VOICE_ENABLED: true,
      COMPANION_VOICE_NAME: 'coral',
      COMPANION_VOICE_SPEED: 1,
      COMPANION_VOICE_MAX_CHARS: 300,
      COMPANION_VOICE_MAX_SEGMENTS: 4,
      COMPANION_VOICE_MAX_CONCURRENCY: 2
    },
    provider: {
      configured: true,
      async synthesize({ text }) {
        return {
          buffer: Buffer.from(text),
          mimeType: 'audio/mpeg',
          format: 'mp3',
          fileName: 'coral-voice.mp3'
        };
      }
    },
    canSendAudio: (target) => target.platform !== 'telegram',
    sendAudio: async (target, audio, options) => {
      audioCalls.push({ target, audio, options });
      return { status: 'accepted', mode: target.platform === 'qq' ? 'record' : 'attachment' };
    },
    sendText: async (target, text, options) => {
      textCalls.push({ target, text, options });
      return { status: 'accepted', mode: 'file' };
    }
  });

  const discordResult = await service.reply({
    text: 'Discord 私聊语音',
    deliveryTarget: buildTarget('discord', 'private'),
    replyToMessageId: 'discord-message'
  });
  assert.deepStrictEqual({ reason: discordResult.reason, sent: discordResult.sent }, {
    reason: 'voice_sent',
    sent: true
  });
  assert.strictEqual(audioCalls[0].target.platform, 'discord');
  assert.strictEqual(audioCalls[0].options.replyToMessageId, 'discord-message');

  const noTargetResult = await service.reply({ text: '没有目标' });
  assert.deepStrictEqual(noTargetResult, {
    handled: false,
    sent: false,
    fallbackText: '没有目标',
    reason: 'unsupported_target'
  });
  const telegramResult = await service.reply({
    text: 'Telegram 不支持',
    deliveryTarget: buildTarget('telegram', 'private')
  });
  assert.strictEqual(telegramResult.reason, 'unsupported_target');

  let unknownAudioCalls = 0;
  let unknownTextCalls = 0;
  const unknownService = createCompanionVoiceService({
    config: { COMPANION_VOICE_ENABLED: true, COMPANION_VOICE_MAX_CHARS: 300, COMPANION_VOICE_MAX_SEGMENTS: 4 },
    provider: {
      configured: true,
      synthesize: async ({ text }) => ({ buffer: Buffer.from(text), mimeType: 'audio/mpeg', format: 'mp3', fileName: 'voice.mp3' })
    },
    canSendAudio: () => true,
    sendAudio: async () => {
      unknownAudioCalls += 1;
      return { status: 'unknown', mode: 'record' };
    },
    sendText: async () => {
      unknownTextCalls += 1;
      return { status: 'accepted' };
    }
  });
  const unknownResult = await unknownService.reply({
    text: '状态不确定。后续不能继续。',
    deliveryTarget: buildTarget('qq', 'private')
  });
  assert.strictEqual(unknownResult.status, 'unknown');
  assert.strictEqual(unknownAudioCalls, 1);
  assert.strictEqual(unknownTextCalls, 0);

  console.log('companionVoiceMultichannel.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
