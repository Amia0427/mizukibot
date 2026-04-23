const config = require('../../../config');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  resolveForcedFallbackMainModelConfig,
  recordMainModelFailure,
  recordMainModelSuccess
} = require('../../../utils/mainModelFallback');
const {
  resolveRoleAwareMainModelConfig,
  resolveUserScopedMainModelConfig,
  shouldBypassMainModelFallback,
  isAdminMainModelUser
} = require('../../../utils/mainModelConfigResolver');
const {
  buildImageModelConfig
} = require('../../../utils/imageModelConfigResolver');

function ensureChatCompletionsUrl(url) {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function getModelName(overrides = null) {
  const model = overrides && typeof overrides === 'object' ? overrides.model : '';
  return String(model || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getTemperature(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.temperature !== undefined
    ? overrides.temperature
    : config.AI_TEMPERATURE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(2, n));
}

function getTopP(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.topP !== undefined
    ? overrides.topP
    : config.AI_TOP_P;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.92;
  return Math.max(0, Math.min(1, n));
}

function getMaxTokens(defaultValue = 3500, overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.maxTokens !== undefined
    ? overrides.maxTokens
    : config.AI_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.max(64, Math.floor(n));
}

function getRetries(defaultValue = 1, overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.retries !== undefined
    ? overrides.retries
    : config.AI_RETRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultValue;
  return Math.max(0, Math.floor(n));
}

function getApiBaseUrl(overrides = null) {
  const raw = overrides && typeof overrides === 'object' ? overrides.apiBaseUrl : '';
  return String(raw || config.API_BASE_URL || '').trim();
}

function getApiKey(overrides = null) {
  const raw = overrides && typeof overrides === 'object' ? overrides.apiKey : '';
  return String(raw || config.API_KEY || '').trim();
}

function buildPrimaryMainModelConfig(overrides = null, userId = '', options = {}) {
  return resolveRoleAwareMainModelConfig(userId, overrides, options);
}

async function withMainModelFallback(action, modelConfig = null, userId = '', options = {}) {
  const bypassFallback = shouldBypassMainModelFallback(userId, options);
  const scope = options?.fallbackScope
    || (String(userId || '').trim() && !options?.forceDefaultFallbackScope && shouldUseAdminSharedFallbackScope(userId, options)
      ? ADMIN_SHARED_FALLBACK_SCOPE
      : undefined);
  const resolvedConfig = resolveUserScopedMainModelConfig(userId, modelConfig, options);
  try {
    const result = await action(resolvedConfig);
    recordMainModelSuccess({ usingFallback: resolvedConfig.__mainFallbackActive }, { scope });
    return result;
  } catch (error) {
    if (bypassFallback) throw error;
    if (resolvedConfig.__mainFallbackActive) throw error;
    const failureState = recordMainModelFailure(error, { scope });
    if (failureState.activated && !resolvedConfig.__mainFallbackActive) {
      const forcedFallbackConfig = resolveForcedFallbackMainModelConfig(
        buildPrimaryMainModelConfig(modelConfig, userId, options),
        { scope }
      );
      const fallbackResult = await action(forcedFallbackConfig);
      recordMainModelSuccess({ usingFallback: true }, { scope });
      return fallbackResult;
    }
    throw error;
  }
}

function shouldUseAdminSharedFallbackScope(userId = '', options = {}) {
  return isAdminMainModelUser(userId, options);
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  return String(content || '');
}

module.exports = {
  buildImageModelConfig,
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRetries,
  getTemperature,
  getTopP,
  normalizeTextContent,
  withMainModelFallback
};
