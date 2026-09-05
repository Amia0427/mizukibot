const axios = require('axios');

const AUDIO_MIME_TYPE = 'audio/mpeg';
const AUDIO_FORMAT = 'mp3';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSpeed(value, fallback = 1) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0 ? speed : fallback;
}

function normalizeAudioBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  return null;
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (headers && typeof headers.get === 'function') return normalizeText(headers.get(name));
  if (!headers || typeof headers !== 'object') return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return normalizeText(key ? headers[key] : '');
}

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function isTimeoutError(error) {
  return ['ECONNABORTED', 'ETIMEDOUT', 'TIMEOUT'].includes(String(error?.code || '').toUpperCase())
    || /timeout/i.test(String(error?.message || error || ''));
}

function isPreDeliveryConnectionError(error) {
  return ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(
    String(error?.code || '').toUpperCase()
  ) && !error?.response;
}

function isRetryableTtsError(error) {
  const status = statusOf(error);
  return status === 429 || status >= 500 || isTimeoutError(error) || isPreDeliveryConnectionError(error);
}

function fileNameForVoice(voice) {
  const safeVoice = normalizeText(voice).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'voice';
  return `${safeVoice}-voice.${AUDIO_FORMAT}`;
}

function createGeneratedAudio(buffer, options = {}) {
  const audio = normalizeAudioBuffer(buffer);
  if (!audio || audio.length === 0) throw new Error('TTS response audio is empty');
  return {
    buffer: audio,
    mimeType: AUDIO_MIME_TYPE,
    format: AUDIO_FORMAT,
    fileName: normalizeText(options.fileName) || fileNameForVoice(options.voice)
  };
}

function assertMp3Format(format) {
  if (normalizeText(format || AUDIO_FORMAT).toLowerCase() !== AUDIO_FORMAT) {
    throw new Error('companion voice only supports mp3');
  }
}

function createRequestWithRetry(request, timeoutMs) {
  return async function requestWithRetry(url, body, options = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await request(url, body, { ...options, timeout: timeoutMs });
      } catch (error) {
        if (attempt === 1 || !isRetryableTtsError(error)) throw error;
      }
    }
    throw new Error('TTS request failed');
  };
}

function createExternalTtsProvider(options = {}) {
  const apiUrl = normalizeText(options.apiUrl);
  const apiKey = normalizeText(options.apiKey);
  const model = normalizeText(options.model);
  const defaultVoice = normalizeText(options.voice);
  const defaultSpeed = normalizeSpeed(options.speed);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000) || 15000);
  const request = options.request || axios.post;
  const requestWithRetry = createRequestWithRetry(request, timeoutMs);

  async function synthesize(input = {}) {
    const text = normalizeText(input.text);
    const voice = normalizeText(input.voice) || defaultVoice;
    const speed = normalizeSpeed(input.speed, defaultSpeed);
    assertMp3Format(input.format);
    if (!apiUrl || !model || !voice) throw new Error('companion voice external TTS is not configured');
    if (!text) throw new Error('voice text is required');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await requestWithRetry(apiUrl, {
      model,
      voice,
      input: text,
      response_format: AUDIO_FORMAT,
      speed
    }, {
      headers,
      responseType: 'arraybuffer'
    });
    const contentType = responseHeader(response, 'content-type');
    if (contentType && !contentType.toLowerCase().startsWith('audio/')) {
      throw new Error('TTS response is not audio');
    }
    return createGeneratedAudio(response?.data, { voice });
  }

  return {
    configured: Boolean(apiUrl && model && defaultVoice),
    synthesize
  };
}

function createLocalTtsProvider(options = {}) {
  const apiUrl = normalizeText(options.localApiUrl);
  const apiKey = normalizeText(options.localApiKey);
  const defaultVoice = normalizeText(options.voice);
  const defaultSpeed = normalizeSpeed(options.speed);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000) || 15000);
  const request = options.request || axios.post;
  const requestWithRetry = createRequestWithRetry(request, timeoutMs);

  async function synthesize(input = {}) {
    const text = normalizeText(input.text);
    const voice = normalizeText(input.voice) || defaultVoice;
    const speed = normalizeSpeed(input.speed, defaultSpeed);
    assertMp3Format(input.format);
    if (!apiUrl || !voice) throw new Error('companion voice local TTS is not configured');
    if (!text) throw new Error('voice text is required');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await requestWithRetry(apiUrl, {
      text,
      voice,
      speed,
      format: AUDIO_FORMAT
    }, {
      headers,
      responseType: 'arraybuffer'
    });
    const contentType = responseHeader(response, 'content-type');
    if (!contentType.toLowerCase().startsWith('audio/')) {
      throw new Error('local TTS response must be audio');
    }
    return createGeneratedAudio(response?.data, { voice });
  }

  return {
    configured: Boolean(apiUrl && defaultVoice),
    synthesize
  };
}

function createCompanionVoiceProvider(options = {}) {
  const provider = normalizeText(options.provider || 'external').toLowerCase();
  if (provider === 'external') return createExternalTtsProvider(options);
  if (provider === 'local') return createLocalTtsProvider(options);
  throw new Error(`unsupported companion voice provider: ${provider}`);
}

module.exports = {
  AUDIO_FORMAT,
  AUDIO_MIME_TYPE,
  createCompanionVoiceProvider,
  createExternalTtsProvider,
  createGeneratedAudio,
  createLocalTtsProvider,
  isRetryableTtsError
};
