const config = require('../../../config');
const { createDeliveryTarget } = require('../../platforms/contracts');
const { sendPrivateVoiceMessage } = require('../../../api/qqActionService');
const { getGroupReplySensitiveGuard } = require('../../../utils/groupReplySensitiveGuard');
const { createCompanionVoiceProvider, createGeneratedAudio } = require('./provider');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createTaskLimiter(maxConcurrency) {
  const limit = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  let active = 0;
  const waiting = [];

  async function run(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  return run;
}

function splitTextIntoVoiceSegments(text, maxChars = 300, maxSegments = 4) {
  const input = normalizeText(text);
  const limit = Math.max(1, Math.floor(Number(maxChars) || 300));
  const segmentLimit = Math.max(1, Math.floor(Number(maxSegments) || 4));
  if (!input) return { segments: [], overflowText: '' };

  const sentences = input.split(/(?<=[。！？!?；;.!])\s*/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  for (const sentence of sentences) {
    for (let index = 0; index < sentence.length; index += limit) {
      chunks.push(sentence.slice(index, index + limit));
    }
  }
  return {
    segments: chunks.slice(0, segmentLimit),
    overflowText: chunks.slice(segmentLimit).join('')
  };
}

function isSupportedTarget(target) {
  const platform = normalizeText(target?.platform).toLowerCase();
  if (platform === 'qq') return ['private', 'group'].includes(normalizeText(target?.chatType).toLowerCase());
  if (platform === 'discord') return ['private', 'group'].includes(normalizeText(target?.chatType).toLowerCase());
  return platform === 'weixin' && normalizeText(target?.chatType).toLowerCase() === 'private';
}

function normalizeSendResult(result, fallbackMode = 'attachment') {
  if (result && ['accepted', 'not_submitted', 'unknown'].includes(result.status)) {
    return { status: result.status, mode: result.mode || fallbackMode };
  }
  return result === false
    ? { status: 'not_submitted', mode: fallbackMode }
    : { status: 'accepted', mode: fallbackMode };
}

function buildSensitiveResult(reason) {
  return {
    handled: true,
    sent: false,
    fallbackText: '',
    reason,
    status: 'blocked'
  };
}

function buildLegacySensitiveResult(reason) {
  return {
    sent: false,
    fallbackText: '',
    reason,
    status: 'blocked'
  };
}

function isSensitiveText(sensitiveGuard, text) {
  return Boolean(text && sensitiveGuard.check(text).blocked);
}

function createCompanionVoiceService(options = {}) {
  const runtimeConfig = options.config || config;
  const sensitiveGuard = options.sensitiveGuard || getGroupReplySensitiveGuard();
  const provider = options.provider || (options.client ? {
    configured: true,
    synthesize: async (input) => createGeneratedAudio(
      await options.client.synthesize(input.text),
      { voice: runtimeConfig.COMPANION_VOICE_NAME }
    )
  } : createCompanionVoiceProvider({
    provider: runtimeConfig.COMPANION_VOICE_PROVIDER,
    apiUrl: runtimeConfig.COMPANION_VOICE_API_URL,
    apiKey: runtimeConfig.COMPANION_VOICE_API_KEY,
    model: runtimeConfig.COMPANION_VOICE_MODEL,
    localApiUrl: runtimeConfig.COMPANION_VOICE_LOCAL_API_URL,
    localApiKey: runtimeConfig.COMPANION_VOICE_LOCAL_API_KEY,
    voice: runtimeConfig.COMPANION_VOICE_NAME,
    speed: runtimeConfig.COMPANION_VOICE_SPEED,
    timeoutMs: runtimeConfig.COMPANION_VOICE_TIMEOUT_MS
  }));
  const sendAudio = options.sendAudio || null;
  const sendText = options.sendText || null;
  const canSendAudio = options.canSendAudio || isSupportedTarget;
  const sendVoice = options.sendPrivateVoiceMessage || sendPrivateVoiceMessage;
  const runTts = createTaskLimiter(runtimeConfig.COMPANION_VOICE_MAX_CONCURRENCY || 2);

  async function replyLegacy(userId, text) {
    const targetUserId = normalizeText(userId);
    const fallbackText = normalizeText(text);
    if (!targetUserId) throw new Error('companion voice requires private userId');
    if (!fallbackText) throw new Error('voice text is required');
    if (isSensitiveText(sensitiveGuard, fallbackText)) return buildLegacySensitiveResult('sensitive_output');
    if (runtimeConfig.COMPANION_VOICE_ENABLED !== true) {
      return { sent: false, fallbackText, reason: 'disabled' };
    }
    let audio;
    try {
      audio = await provider.synthesize({
        text: fallbackText,
        voice: runtimeConfig.COMPANION_VOICE_NAME,
        speed: runtimeConfig.COMPANION_VOICE_SPEED,
        format: 'mp3'
      });
    } catch (error) {
      console.warn('[companion-voice] TTS failed', { error: error?.message || String(error || '') });
      return { sent: false, fallbackText, reason: 'tts_failed' };
    }
    try {
      await sendVoice(targetUserId, audio.buffer, {
        source: 'companion_voice',
        triggerReason: 'explicit_private_voice_reply'
      });
      return { sent: true, fallbackText, reason: 'voice_sent' };
    } catch (error) {
      console.warn('[companion-voice] QQ send failed', { error: error?.message || String(error || '') });
      return { sent: false, fallbackText, reason: 'send_failed' };
    }
  }

  async function sendFallbackText(target, text, replyToMessageId) {
    if (typeof sendText !== 'function') return { status: 'not_submitted' };
    try {
      return normalizeSendResult(await sendText(target, text, {
        source: 'companion_voice',
        triggerReason: 'voice_text_fallback',
        replyToMessageId
      }));
    } catch (_) {
      return { status: 'unknown', mode: 'file' };
    }
  }

  async function replyForTarget(input = {}) {
    const fallbackText = normalizeText(input.text);
    const userInputText = normalizeText(input.userInputText);
    const target = input.deliveryTarget || null;
    const replyToMessageId = normalizeText(input.replyToMessageId);
    if (!fallbackText) throw new Error('voice text is required');
    if (isSensitiveText(sensitiveGuard, userInputText)) return buildSensitiveResult('sensitive_input');
    if (isSensitiveText(sensitiveGuard, fallbackText)) return buildSensitiveResult('sensitive_output');
    if (runtimeConfig.COMPANION_VOICE_ENABLED !== true) {
      return { handled: false, sent: false, fallbackText, reason: 'disabled' };
    }
    if (!target || !isSupportedTarget(target) || typeof sendAudio !== 'function' || canSendAudio(target) === false) {
      return { handled: false, sent: false, fallbackText, reason: 'unsupported_target' };
    }
    if (!provider.configured) {
      return { handled: false, sent: false, fallbackText, reason: 'provider_not_configured' };
    }

    const split = splitTextIntoVoiceSegments(
      fallbackText,
      runtimeConfig.COMPANION_VOICE_MAX_CHARS || 300,
      runtimeConfig.COMPANION_VOICE_MAX_SEGMENTS || 4
    );
    let voiceCount = 0;
    let textFallbackCount = 0;
    const segmentResults = [];

    for (const segment of split.segments) {
      let audio;
      try {
        audio = await runTts(() => provider.synthesize({
          text: segment,
          voice: runtimeConfig.COMPANION_VOICE_NAME,
          speed: runtimeConfig.COMPANION_VOICE_SPEED,
          format: 'mp3'
        }));
      } catch (error) {
        console.warn('[companion-voice] TTS failed', { error: error?.message || String(error || '') });
        const textResult = await sendFallbackText(target, segment, replyToMessageId);
        segmentResults.push({ kind: 'text', status: textResult.status });
        if (textResult.status === 'unknown') {
          return {
            handled: true,
            sent: false,
            fallbackText: '',
            reason: 'unknown',
            status: 'unknown',
            voiceCount,
            textFallbackCount,
            segmentResults
          };
        }
        textFallbackCount += 1;
        continue;
      }

      let sendResult;
      try {
        sendResult = normalizeSendResult(await sendAudio(target, audio, {
          source: 'companion_voice',
          triggerReason: 'explicit_voice_reply',
          replyToMessageId
        }), 'attachment');
      } catch (_) {
        sendResult = { status: 'unknown', mode: 'attachment' };
      }
      segmentResults.push({ kind: 'voice', status: sendResult.status, mode: sendResult.mode });
      if (sendResult.status === 'accepted') {
        voiceCount += 1;
        continue;
      }
      if (sendResult.status === 'unknown') {
        return {
          handled: true,
          sent: false,
          fallbackText: '',
          reason: 'unknown',
          status: 'unknown',
          voiceCount,
          textFallbackCount,
          segmentResults
        };
      }

      const textResult = await sendFallbackText(target, segment, replyToMessageId);
      segmentResults.push({ kind: 'text', status: textResult.status });
      if (textResult.status === 'unknown') {
        return {
          handled: true,
          sent: false,
          fallbackText: '',
          reason: 'unknown',
          status: 'unknown',
          voiceCount,
          textFallbackCount,
          segmentResults
        };
      }
      textFallbackCount += 1;
    }

    if (split.overflowText) {
      const textResult = await sendFallbackText(target, split.overflowText, replyToMessageId);
      segmentResults.push({ kind: 'text_overflow', status: textResult.status });
      if (textResult.status === 'unknown') {
        return {
          handled: true,
          sent: false,
          fallbackText: '',
          reason: 'unknown',
          status: 'unknown',
          voiceCount,
          textFallbackCount,
          segmentResults
        };
      }
      textFallbackCount += 1;
    }

    return {
      handled: true,
      sent: voiceCount > 0 && textFallbackCount === 0,
      fallbackText: '',
      reason: textFallbackCount > 0 ? 'partial_text_fallback' : 'voice_sent',
      status: 'accepted',
      voiceCount,
      textFallbackCount,
      segmentResults
    };
  }

  async function reply(input, text) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return replyForTarget(input);
    return replyLegacy(input, text);
  }

  return { reply };
}

module.exports = {
  createCompanionVoiceService,
  isSupportedTarget,
  splitTextIntoVoiceSegments
};
