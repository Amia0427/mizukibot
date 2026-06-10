const config = require('../config');
const { isAdminMainModelUser, resolveUserScopedMainModelConfig } = require('./mainModelConfigResolver');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  isFallbackActive
} = require('./mainModelFallback');

function normalizeText(value) {
  return String(value || '').trim();
}

function resolveAdminImageConfig(overrides = null, userId = '', options = {}) {
  const isAdmin = isAdminMainModelUser(userId, options);
  if (!isAdmin) return null;

  if (isFallbackActive({ scope: ADMIN_SHARED_FALLBACK_SCOPE })) {
    const fallbackMainConfig = resolveUserScopedMainModelConfig(userId, overrides, options);
    return {
      model: normalizeText(fallbackMainConfig?.model || config.ADMIN_AI_FALLBACK_MODEL || config.ADMIN_AI_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4',
      apiBaseUrl: normalizeText(fallbackMainConfig?.apiBaseUrl || config.ADMIN_AI_FALLBACK_API_BASE_URL || config.ADMIN_API_BASE_URL || config.API_BASE_URL || ''),
      apiKey: normalizeText(fallbackMainConfig?.apiKey || config.ADMIN_AI_FALLBACK_API_KEY || config.ADMIN_API_KEY || config.API_KEY || '')
    };
  }

  const baseUrl = normalizeText(
    (overrides && typeof overrides === 'object' ? overrides.adminImageApiBaseUrl : '')
    || config.ADMIN_IMAGE_API_BASE_URL
    || ''
  );
  const apiKey = normalizeText(
    (overrides && typeof overrides === 'object' ? overrides.adminImageApiKey : '')
    || config.ADMIN_IMAGE_API_KEY
    || ''
  );
  if (!baseUrl || !apiKey) return null;

  return {
    model: normalizeText(
      (overrides && typeof overrides === 'object' ? overrides.adminImageModel : '')
      || config.ADMIN_IMAGE_MODEL
      || config.ADMIN_AI_MODEL
      || config.IMAGE_MODEL
      || config.AI_MODEL
      || 'gpt-5.4'
    ) || 'gpt-5.4',
    apiBaseUrl: baseUrl,
    apiKey
  };
}

function resolveDedicatedImageConfig(overrides = null) {
  const baseUrl = normalizeText(
    (overrides && typeof overrides === 'object' ? overrides.imageApiBaseUrl : '')
    || config.IMAGE_API_BASE_URL
    || ''
  );
  const apiKey = normalizeText(
    (overrides && typeof overrides === 'object' ? overrides.imageApiKey : '')
    || config.IMAGE_API_KEY
    || ''
  );
  if (!baseUrl || !apiKey) return null;

  return {
    apiBaseUrl: baseUrl,
    apiKey
  };
}

function getImageModelName(overrides = null, userId = '', options = {}) {
  const adminImageConfig = resolveAdminImageConfig(overrides, userId, options);
  if (adminImageConfig?.model) return adminImageConfig.model;
  const model = overrides && typeof overrides === 'object' ? (overrides.imageModel || '') : '';
  const fallbackModel = overrides && typeof overrides === 'object' ? overrides.model : '';
  const dedicatedImageConfig = resolveDedicatedImageConfig(overrides);
  if (!dedicatedImageConfig) {
    const mainConfig = resolveUserScopedMainModelConfig(userId, overrides, options);
    return normalizeText(mainConfig?.model || fallbackModel || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
  }
  return normalizeText(
    model
    || config.IMAGE_MODEL
    || fallbackModel
    || config.AI_MODEL
    || 'gpt-5.4'
  ) || 'gpt-5.4';
}

function getImageApiBaseUrl(overrides = null, userId = '', options = {}) {
  const adminImageConfig = resolveAdminImageConfig(overrides, userId, options);
  if (adminImageConfig?.apiBaseUrl) return adminImageConfig.apiBaseUrl;

  const dedicatedImageConfig = resolveDedicatedImageConfig(overrides);
  if (dedicatedImageConfig?.apiBaseUrl) return dedicatedImageConfig.apiBaseUrl;

  const mainConfig = resolveUserScopedMainModelConfig(userId, overrides, options);
  return normalizeText(mainConfig?.apiBaseUrl || config.API_BASE_URL || '');
}

function getImageApiKey(overrides = null, userId = '', options = {}) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.imageApiKey
    : '';
  if (normalizeText(raw)) return normalizeText(raw);

  const adminImageConfig = resolveAdminImageConfig(overrides, userId, options);
  if (adminImageConfig?.apiKey) return adminImageConfig.apiKey;

  const dedicatedImageConfig = resolveDedicatedImageConfig(overrides);
  if (dedicatedImageConfig?.apiKey) return dedicatedImageConfig.apiKey;

  const mainConfig = resolveUserScopedMainModelConfig(userId, overrides, options);
  return normalizeText(mainConfig?.apiKey || config.API_KEY || '');
}

function buildImageModelConfig(overrides = null, userId = '', options = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  const imageModel = getImageModelName(overrides, userId, options);
  const imageApiBaseUrl = getImageApiBaseUrl(overrides, userId, options);
  const imageApiKey = getImageApiKey(overrides, userId, options);
  const timeoutMs = Math.max(1000, Number(base.timeoutMs || config.IMAGE_MODEL_TIMEOUT_MS || 18000) || 18000);
  const retries = Math.max(0, Math.min(3, Number.isFinite(Number(base.retries))
    ? Number(base.retries)
    : Number(config.IMAGE_MODEL_RETRIES || 0)));
  const promptTokenWarningThreshold = Math.max(
    1024,
    Number(base.promptTokenWarningThreshold || config.IMAGE_MODEL_INPUT_TOKEN_WARN_THRESHOLD || 18000) || 18000
  );
  const promptTokenHardLimit = Math.max(
    2048,
    Number(base.promptTokenHardLimit || config.IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT || 20000) || 20000
  );

  return {
    ...base,
    model: imageModel,
    imageModel,
    apiBaseUrl: imageApiBaseUrl,
    imageApiBaseUrl,
    apiKey: imageApiKey,
    imageApiKey,
    timeoutMs,
    retries: Math.floor(retries),
    promptTokenWarningThreshold: Math.floor(promptTokenWarningThreshold),
    promptTokenHardLimit: Math.floor(promptTokenHardLimit)
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
