const axios = require('axios');
const config = require('../config');
const { drawPicture } = require('./legacy/aiHost');
const { getApiProvider, normalizeProviderRequestHeaders } = require('../utils/modelProvider');

function normalizeText(value) {
  return String(value || '').trim();
}

function clampTimeoutMs(value, fallback = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(5000, Math.floor(n));
}

function toJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function buildBotDiaryQzoneImageProviderConfig() {
  const model = normalizeText(config.BOT_DIARY_QZONE_IMAGE_PROVIDER_MODEL);
  const apiBaseUrl = normalizeText(config.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL);
  const apiKey = normalizeText(config.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_KEY);

  if (!model || !apiBaseUrl || !apiKey) {
    return {
      enabled: false,
      model,
      apiBaseUrl,
      apiKey
    };
  }

  return {
    enabled: true,
    model,
    apiBaseUrl,
    apiKey
  };
}

function resolveBotDiaryQzoneImageRequestUrl(apiBaseUrl = '', model = '') {
  const base = normalizeText(apiBaseUrl).replace(/\/+$/g, '');
  const safeModel = normalizeText(model);
  if (!base || !safeModel) return '';
  if (/generateContent(?:$|[?#])/i.test(base)) return base;
  if (/\/models\/[^/]+$/i.test(base)) return `${base}:generateContent`;
  return `${base}/models/${encodeURIComponent(safeModel)}:generateContent`;
}

function buildBotDiaryQzoneImageHeaders(apiKey = '', apiBaseUrl = '') {
  const key = normalizeText(apiKey);
  const provider = getApiProvider(apiBaseUrl, '');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*'
  };
  if (provider === 'gemini_native') {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (provider === 'openai_compatible') {
    headers['User-Agent'] = String(
      config.MODEL_HTTP_USER_AGENT
      || config.MAIN_REPLY_USER_AGENT
      || config.HTTP_USER_AGENT
      || ''
    ).trim() || 'Mozilla/5.0';
  }
  const normalizedHeaders = normalizeProviderRequestHeaders(provider, headers) || headers;
  if (provider !== 'openai_compatible') normalizedHeaders['User-Agent'] = false;
  return normalizedHeaders;
}

function buildBotDiaryQzoneImageRequestBody(prompt = '') {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: normalizeText(prompt)
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: '16:9',
        image_size: '2K'
      }
    }
  };
}

function buildBase64ImageDataUrl(mimeType = '', data = '') {
  const safeData = normalizeText(data).replace(/\s+/g, '');
  if (!safeData) return '';
  const safeMimeType = normalizeText(mimeType).toLowerCase() || 'image/png';
  return `data:${safeMimeType};base64,${safeData}`;
}

function extractUrlFromText(value = '') {
  const match = String(value || '').match(/https?:\/\/[^\s"'`<>]+/i);
  return normalizeText(match ? match[0] : '');
}

function extractImageSourceFromPart(part = {}) {
  const inlineData = part?.inlineData || part?.inline_data || {};
  const inlineBase64 = normalizeText(
    inlineData?.data
    || inlineData?.bytesBase64
    || part?.b64_json
    || part?.base64
  );
  if (inlineBase64) {
    return buildBase64ImageDataUrl(
      inlineData?.mimeType || inlineData?.mime_type || part?.mimeType || part?.mime_type,
      inlineBase64
    );
  }

  const fileData = part?.fileData || part?.file_data || {};
  const fileUrl = normalizeText(
    fileData?.fileUri
    || fileData?.file_uri
    || fileData?.uri
    || fileData?.url
    || part?.fileUri
    || part?.file_uri
    || part?.url
    || part?.image_url
  );
  if (fileUrl) return fileUrl;

  return extractUrlFromText(part?.text || '');
}

function extractBotDiaryQzoneImageSource(payload) {
  const data = toJsonObject(payload);

  const candidateLists = [
    Array.isArray(data?.candidates) ? data.candidates : [],
    Array.isArray(data?.response?.candidates) ? data.response.candidates : []
  ];
  for (const candidates of candidateLists) {
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts)
        ? candidate.content.parts
        : Array.isArray(candidate?.parts)
          ? candidate.parts
          : [];
      for (const part of parts) {
        const source = extractImageSourceFromPart(part);
        if (source) return source;
      }
    }
  }

  const dataItems = Array.isArray(data?.data) ? data.data : [];
  for (const item of dataItems) {
    const source = extractImageSourceFromPart(item);
    if (source) return source;
  }

  const images = Array.isArray(data?.images) ? data.images : [];
  for (const item of images) {
    const source = extractImageSourceFromPart(item);
    if (source) return source;
  }

  return '';
}

function describeBotDiaryQzoneImageFailure(payload) {
  const data = toJsonObject(payload);
  const blockReason = normalizeText(
    data?.promptFeedback?.blockReason
    || data?.prompt_feedback?.block_reason
  );
  if (blockReason) {
    return `image generation blocked: ${blockReason}`;
  }

  const errorMessage = normalizeText(
    data?.error?.message
    || data?.message
    || data?.detail
  );
  if (errorMessage) return errorMessage;

  return 'image generation returned no image';
}

async function drawBotDiaryQzonePicture(prompt = '', options = {}) {
  const provider = typeof options.buildProviderConfig === 'function'
    ? options.buildProviderConfig()
    : buildBotDiaryQzoneImageProviderConfig();
  if (!provider?.enabled) return null;

  const textPrompt = normalizeText(prompt);
  if (!textPrompt) return null;

  const requestUrl = resolveBotDiaryQzoneImageRequestUrl(provider.apiBaseUrl, provider.model);
  if (!requestUrl) return null;

  const httpClient = options.httpClient || axios;
  const timeoutMs = clampTimeoutMs(options.timeoutMs || config.REQUEST_TIMEOUT_MS, 60000);
  try {
    const response = await httpClient.post(
      requestUrl,
      buildBotDiaryQzoneImageRequestBody(textPrompt),
      {
        timeout: timeoutMs,
        proxy: false,
        headers: buildBotDiaryQzoneImageHeaders(provider.apiKey, requestUrl)
      }
    );
    const imageSource = extractBotDiaryQzoneImageSource(response?.data);
    if (imageSource) return imageSource;
    throw new Error(describeBotDiaryQzoneImageFailure(response?.data));
  } catch (error) {
    const responseMessage = describeBotDiaryQzoneImageFailure(error?.response?.data);
    const hasResponsePayload = Boolean(error?.response?.data);
    const message = hasResponsePayload
      ? (normalizeText(responseMessage) || normalizeText(error?.message) || 'image generation failed')
      : (normalizeText(error?.message) || normalizeText(responseMessage) || 'image generation failed');
    throw new Error(message);
  }
}

module.exports = {
  buildBotDiaryQzoneImageProviderConfig,
  buildBotDiaryQzoneImageHeaders,
  buildBotDiaryQzoneImageRequestBody,
  drawBotDiaryQzonePicture,
  drawPicture,
  extractBotDiaryQzoneImageSource,
  resolveBotDiaryQzoneImageRequestUrl
};
