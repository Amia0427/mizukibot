const config = require('../../../config');
const { sendPrivateVoiceMessage } = require('../../../api/qqActionService');
const { createCompanionVoiceClient } = require('./client');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createCompanionVoiceService(options = {}) {
  const runtimeConfig = options.config || config;
  const client = options.client || createCompanionVoiceClient({
    apiUrl: runtimeConfig.COMPANION_VOICE_API_URL,
    apiKey: runtimeConfig.COMPANION_VOICE_API_KEY,
    model: runtimeConfig.COMPANION_VOICE_MODEL,
    voice: runtimeConfig.COMPANION_VOICE_NAME,
    speed: runtimeConfig.COMPANION_VOICE_SPEED,
    timeoutMs: runtimeConfig.COMPANION_VOICE_TIMEOUT_MS
  });
  const sendVoice = options.sendPrivateVoiceMessage || sendPrivateVoiceMessage;

  async function reply(userId, text) {
    const targetUserId = normalizeText(userId);
    const fallbackText = normalizeText(text);
    if (!targetUserId) throw new Error('companion voice requires private userId');
    if (!fallbackText) throw new Error('voice text is required');
    if (fallbackText.length > runtimeConfig.COMPANION_VOICE_MAX_CHARS) throw new Error('voice text too long');
    if (runtimeConfig.COMPANION_VOICE_ENABLED !== true) {
      return { sent: false, fallbackText, reason: 'disabled' };
    }
    let audio;
    try {
      audio = await client.synthesize(fallbackText);
    } catch (error) {
      console.warn('[companion-voice] TTS failed', { error: error?.message || String(error || '') });
      return { sent: false, fallbackText, reason: 'tts_failed' };
    }
    try {
      await sendVoice(targetUserId, audio, {
        source: 'companion_voice',
        triggerReason: 'explicit_private_voice_reply'
      });
      return { sent: true, fallbackText, reason: 'voice_sent' };
    } catch (error) {
      console.warn('[companion-voice] QQ send failed', { error: error?.message || String(error || '') });
      return { sent: false, fallbackText, reason: 'send_failed' };
    }
  }

  return { reply };
}

module.exports = {
  createCompanionVoiceService
};
