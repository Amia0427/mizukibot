const config = require('../config');
const { isAdminMainModelUser } = require('./mainModelConfigResolver');

function normalizeText(value) {
  return String(value || '').trim();
}

function getImageModelName(overrides = null, userId = '', options = {}) {
  const model = overrides && typeof overrides === 'object'
    ? (overrides.imageModel || '')
    : '';
  const fallbackModel = overrides && typeof overrides === 'object'
    ? overrides.model
    : '';
  const isAdmin = isAdminMainModelUser(userId, options);
  return normalizeText(
    model
    || (isAdmin ? config.ADMIN_IMAGE_MODEL : '')
    || config.IMAGE_MODEL
    || fallbackModel
    || (isAdmin ? config.ADMIN_AI_MODEL : '')
    || config.AI_MODEL
    || 'gpt-5.4'
  ) || 'gpt-5.4';
}

function getImageApiBaseUrl(overrides = null, userId = '', options = {}) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.imageApiBaseUrl
    : '';
  const isAdmin = isAdminMainModelUser(userId, options);
  return normalizeText(
    raw
    || config.IMAGE_API_BASE_URL
    || (isAdmin ? config.ADMIN_API_BASE_URL : '')
    || (overrides && typeof overrides === 'object' ? overrides.apiBaseUrl : '')
    || config.API_BASE_URL
    || ''
  );
}

function getImageApiKey(overrides = null, userId = '', options = {}) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.imageApiKey
    : '';
  if (normalizeText(raw)) return normalizeText(raw);

  const dedicatedBaseUrl = overrides && typeof overrides === 'object'
    ? overrides.imageApiBaseUrl
    : '';
  if (normalizeText(dedicatedBaseUrl || config.IMAGE_API_BASE_URL || '')) {
    return normalizeText(config.IMAGE_API_KEY || (overrides && typeof overrides === 'object' ? overrides.apiKey : '') || config.API_KEY || '');
  }

  const isAdmin = isAdminMainModelUser(userId, options);
  if (isAdmin && normalizeText(config.ADMIN_API_BASE_URL || '')) {
    return normalizeText(config.ADMIN_API_KEY || (overrides && typeof overrides === 'object' ? overrides.apiKey : '') || config.API_KEY || '');
  }

  return normalizeText((overrides && typeof overrides === 'object' ? overrides.apiKey : '') || config.API_KEY || '');
}

function buildImageModelConfig(overrides = null, userId = '', options = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  const imageModel = getImageModelName(overrides, userId, options);
  const imageApiBaseUrl = getImageApiBaseUrl(overrides, userId, options);
  const imageApiKey = getImageApiKey(overrides, userId, options);

  return {
    ...base,
    model: imageModel,
    imageModel,
    apiBaseUrl: imageApiBaseUrl,
    imageApiBaseUrl,
    apiKey: imageApiKey,
    imageApiKey
  };
}

function buildVisionCaptionWorkerModelConfig() {
  return {
    model: normalizeText(config.VISION_CAPTION_WORKER_MODEL || config.IMAGE_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4',
    baseUrl: normalizeText(config.VISION_CAPTION_WORKER_API_BASE_URL || ''),
    apiKey: normalizeText(config.VISION_CAPTION_WORKER_API_KEY || ''),
    maxTokens: Math.max(256, Number(config.VISION_CAPTION_WORKER_MAX_TOKENS || 2200) || 2200),
    temperature: 0.1,
    retries: 0,
    timeoutMs: Math.max(1000, Number(config.VISION_CAPTION_WORKER_TIMEOUT_MS || 12000) || 12000)
  };
}

module.exports = {
  buildImageModelConfig,
  buildVisionCaptionWorkerModelConfig,
  getImageApiBaseUrl,
  getImageApiKey,
  getImageModelName
};
