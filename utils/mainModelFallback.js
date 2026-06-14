const config = require('../config');

const PERMANENT_FALLBACK_UNTIL = -1;
const DEFAULT_FALLBACK_SCOPE = 'default';
const ADMIN_SHARED_FALLBACK_SCOPE = 'admin_shared';

const scopeStates = new Map();
const warnedFallbackConfigKeys = new Set();

function normalizeText(value) {
  return String(value || '').trim();
}

function warnOnce(key = '', message = '', details = {}) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey || warnedFallbackConfigKeys.has(normalizedKey)) return;
  warnedFallbackConfigKeys.add(normalizedKey);
  console.warn(message, details);
}

function createEmptyState() {
  return {
    consecutiveFailures: 0,
    fallbackUntil: 0,
    lastActivatedAt: 0,
    lastFailureAt: 0,
    lastFailureStatus: 0,
    lastError: ''
  };
}

function normalizeScope(scope = '') {
  return normalizeText(scope) === ADMIN_SHARED_FALLBACK_SCOPE
    ? ADMIN_SHARED_FALLBACK_SCOPE
    : DEFAULT_FALLBACK_SCOPE;
}

function getScopeState(scope = DEFAULT_FALLBACK_SCOPE) {
  const normalizedScope = normalizeScope(scope);
  if (!scopeStates.has(normalizedScope)) {
    scopeStates.set(normalizedScope, createEmptyState());
  }
  return scopeStates.get(normalizedScope);
}

function resetScopeState(scope = DEFAULT_FALLBACK_SCOPE) {
  const state = getScopeState(scope);
  state.consecutiveFailures = 0;
  state.fallbackUntil = 0;
  state.lastActivatedAt = 0;
  state.lastFailureAt = 0;
  state.lastFailureStatus = 0;
  state.lastError = '';
}

function normalizeScopeOptions(options = null) {
  if (typeof options === 'string') {
    return {
      scope: normalizeScope(options),
      now: undefined
    };
  }
  if (typeof options === 'number') {
    return {
      scope: DEFAULT_FALLBACK_SCOPE,
      now: options
    };
  }
  const input = options && typeof options === 'object' ? options : {};
  return {
    scope: normalizeScope(input.scope),
    now: Number.isFinite(Number(input.now)) ? Number(input.now) : undefined
  };
}

function getScopeConfig(scope = DEFAULT_FALLBACK_SCOPE) {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === ADMIN_SHARED_FALLBACK_SCOPE) {
    return {
      scope: normalizedScope,
      enabled: Boolean(config.ADMIN_AI_FALLBACK_ENABLED),
      fallbackModel: normalizeText(config.ADMIN_AI_FALLBACK_MODEL),
      fallbackProvider: normalizeText(config.ADMIN_AI_FALLBACK_PROVIDER),
      fallbackApiBaseUrl: normalizeText(config.ADMIN_AI_FALLBACK_API_BASE_URL),
      fallbackApiKey: normalizeText(config.ADMIN_AI_FALLBACK_API_KEY),
      failureThreshold: Number(config.ADMIN_AI_FALLBACK_FAILURE_THRESHOLD),
      cooldownMs: Number(config.ADMIN_AI_FALLBACK_COOLDOWN_MS),
      defaultFailureThreshold: 3,
      defaultCooldownMs: 900000
    };
  }

  return {
    scope: DEFAULT_FALLBACK_SCOPE,
    enabled: Boolean(config.AI_FALLBACK_ENABLED),
    fallbackModel: normalizeText(config.AI_FALLBACK_MODEL),
    fallbackProvider: normalizeText(config.AI_FALLBACK_PROVIDER),
    fallbackApiBaseUrl: normalizeText(config.AI_FALLBACK_API_BASE_URL),
    fallbackApiKey: normalizeText(config.AI_FALLBACK_API_KEY),
    failureThreshold: Number(config.AI_FALLBACK_FAILURE_THRESHOLD),
    cooldownMs: Number(config.AI_FALLBACK_COOLDOWN_MS),
    defaultFailureThreshold: 3,
    defaultCooldownMs: 600000
  };
}

function getFailureThreshold(scope = DEFAULT_FALLBACK_SCOPE) {
  const scopeConfig = getScopeConfig(scope);
  const raw = Number(scopeConfig.failureThreshold);
  if (!Number.isFinite(raw) || raw <= 0) return scopeConfig.defaultFailureThreshold;
  return Math.max(1, Math.floor(raw));
}

function getCooldownMs(scope = DEFAULT_FALLBACK_SCOPE) {
  const scopeConfig = getScopeConfig(scope);
  const raw = Number(scopeConfig.cooldownMs);
  if (!Number.isFinite(raw)) return scopeConfig.defaultCooldownMs;
  if (raw <= 0) return 0;
  return Math.max(1000, Math.floor(raw));
}

function getFallbackModelName(scope = DEFAULT_FALLBACK_SCOPE) {
  return normalizeText(getScopeConfig(scope).fallbackModel);
}

function getFallbackApiBaseUrl(scope = DEFAULT_FALLBACK_SCOPE) {
  return normalizeText(getScopeConfig(scope).fallbackApiBaseUrl);
}

function getFallbackProvider(scope = DEFAULT_FALLBACK_SCOPE) {
  return normalizeText(getScopeConfig(scope).fallbackProvider);
}

function getFallbackApiKey(scope = DEFAULT_FALLBACK_SCOPE) {
  return normalizeText(getScopeConfig(scope).fallbackApiKey);
}

function isFallbackConfigured(scope = DEFAULT_FALLBACK_SCOPE) {
  const scopeConfig = getScopeConfig(scope);
  return Boolean(scopeConfig.enabled) && Boolean(getFallbackModelName(scope));
}

function warnIfFallbackEnabledButIncomplete(scope = DEFAULT_FALLBACK_SCOPE) {
  const normalizedScope = normalizeScope(scope);
  const scopeConfig = getScopeConfig(normalizedScope);
  if (!scopeConfig.enabled || getFallbackModelName(normalizedScope)) return;
  warnOnce(`fallback-config:${normalizedScope}`, `[main-model-fallback:${normalizedScope}] enabled but fallback model is empty`, {
    scope: normalizedScope
  });
}

function resetMainModelFallbackState(options = null) {
  const normalized = normalizeScopeOptions(options);
  resetScopeState(normalized.scope);
}

function expireFallbackIfNeeded(scope = DEFAULT_FALLBACK_SCOPE, now = Date.now()) {
  const normalizedScope = normalizeScope(scope);
  if (!isFallbackConfigured(normalizedScope)) {
    resetScopeState(normalizedScope);
    return false;
  }

  const state = getScopeState(normalizedScope);
  if (!state.fallbackUntil || state.fallbackUntil === PERMANENT_FALLBACK_UNTIL || now < state.fallbackUntil) return false;

  state.consecutiveFailures = 0;
  state.fallbackUntil = 0;
  state.lastActivatedAt = 0;
  return true;
}

function isFallbackActive(options = null) {
  const normalized = normalizeScopeOptions(options);
  if (!isFallbackConfigured(normalized.scope)) return false;
  const now = normalized.now ?? Date.now();
  expireFallbackIfNeeded(normalized.scope, now);
  const state = getScopeState(normalized.scope);
  return state.fallbackUntil === PERMANENT_FALLBACK_UNTIL || state.fallbackUntil > now;
}

function safeErrorText(error) {
  const payload = error?.response?.data;
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const nested = payload?.error?.message || payload?.error || payload?.message;
    if (typeof nested === 'string') return nested;
    try {
      return JSON.stringify(payload);
    } catch (_) {}
  }

  return normalizeText(error?.message || error);
}

function isMainModelAvailabilityError(error, options = null) {
  const normalized = normalizeScopeOptions(options);
  if (!isFallbackConfigured(normalized.scope)) return false;
  return Boolean(error);
}

function isImmediateFallbackFailure(error) {
  const status = Number(error?.response?.status || 0);
  return status === 401 || status === 403;
}

function buildPrimaryConfig(baseConfig = null) {
  const base = baseConfig && typeof baseConfig === 'object' ? { ...baseConfig } : {};
  return {
    ...base,
    model: normalizeText(base.model || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4',
    apiBaseUrl: normalizeText(base.apiBaseUrl || config.API_BASE_URL || ''),
    apiKey: normalizeText(base.apiKey || config.API_KEY || '')
  };
}

function resolveMainModelConfig(baseConfig = null, options = null) {
  const normalized = normalizeScopeOptions(options);
  const primaryConfig = buildPrimaryConfig(baseConfig);
  warnIfFallbackEnabledButIncomplete(normalized.scope);
  const state = getScopeState(normalized.scope);
  if (!isFallbackActive(normalized)) {
    return {
      ...primaryConfig,
      __mainFallbackActive: false,
      __mainFallbackScope: normalized.scope,
      __mainFallbackReason: normalizeText(state.lastError)
    };
  }

  return {
    ...primaryConfig,
    model: getFallbackModelName(normalized.scope) || primaryConfig.model,
    provider: getFallbackProvider(normalized.scope) || primaryConfig.provider,
    apiBaseUrl: getFallbackApiBaseUrl(normalized.scope) || primaryConfig.apiBaseUrl,
    apiKey: getFallbackApiKey(normalized.scope) || primaryConfig.apiKey,
    __mainModelSource: getFallbackModelName(normalized.scope) ? `${normalized.scope}.fallbackModel` : primaryConfig.__mainModelSource,
    __mainProviderSource: getFallbackProvider(normalized.scope) ? `${normalized.scope}.fallbackProvider` : primaryConfig.__mainProviderSource,
    __mainApiBaseUrlSource: getFallbackApiBaseUrl(normalized.scope) ? `${normalized.scope}.fallbackApiBaseUrl` : primaryConfig.__mainApiBaseUrlSource,
    __mainApiKeySource: getFallbackApiKey(normalized.scope) ? `${normalized.scope}.fallbackApiKey` : primaryConfig.__mainApiKeySource,
    __mainFallbackActive: true,
    __mainFallbackScope: normalized.scope,
    __mainFallbackReason: normalizeText(state.lastError)
  };
}

function resolveForcedFallbackMainModelConfig(baseConfig = null, options = null) {
  const normalized = normalizeScopeOptions(options);
  const primaryConfig = buildPrimaryConfig(baseConfig);
  warnIfFallbackEnabledButIncomplete(normalized.scope);
  const state = getScopeState(normalized.scope);
  return {
    ...primaryConfig,
    model: getFallbackModelName(normalized.scope) || primaryConfig.model,
    provider: getFallbackProvider(normalized.scope) || primaryConfig.provider,
    apiBaseUrl: getFallbackApiBaseUrl(normalized.scope) || primaryConfig.apiBaseUrl,
    apiKey: getFallbackApiKey(normalized.scope) || primaryConfig.apiKey,
    __mainModelSource: getFallbackModelName(normalized.scope) ? `${normalized.scope}.fallbackModel` : primaryConfig.__mainModelSource,
    __mainProviderSource: getFallbackProvider(normalized.scope) ? `${normalized.scope}.fallbackProvider` : primaryConfig.__mainProviderSource,
    __mainApiBaseUrlSource: getFallbackApiBaseUrl(normalized.scope) ? `${normalized.scope}.fallbackApiBaseUrl` : primaryConfig.__mainApiBaseUrlSource,
    __mainApiKeySource: getFallbackApiKey(normalized.scope) ? `${normalized.scope}.fallbackApiKey` : primaryConfig.__mainApiKeySource,
    __mainFallbackActive: true,
    __mainFallbackForced: true,
    __mainFallbackScope: normalized.scope,
    __mainFallbackReason: normalizeText(state.lastError)
  };
}

function getMainModelFallbackStatus(options = null) {
  const normalized = normalizeScopeOptions(options);
  const now = normalized.now ?? Date.now();
  expireFallbackIfNeeded(normalized.scope, now);
  const state = getScopeState(normalized.scope);
  return {
    scope: normalized.scope,
    enabled: getScopeConfig(normalized.scope).enabled,
    configured: isFallbackConfigured(normalized.scope),
    active: isFallbackActive({ scope: normalized.scope, now }),
    permanent: state.fallbackUntil === PERMANENT_FALLBACK_UNTIL,
    consecutiveFailures: state.consecutiveFailures,
    fallbackUntil: state.fallbackUntil,
    lastActivatedAt: state.lastActivatedAt,
    lastFailureAt: state.lastFailureAt,
    lastFailureStatus: state.lastFailureStatus,
    lastError: state.lastError,
    failureThreshold: getFailureThreshold(normalized.scope),
    cooldownMs: getCooldownMs(normalized.scope),
    fallbackModel: getFallbackModelName(normalized.scope)
  };
}

function recordMainModelFailure(error, options = null) {
  const normalized = normalizeScopeOptions(options);
  const now = normalized.now ?? Date.now();
  expireFallbackIfNeeded(normalized.scope, now);

  const counted = isMainModelAvailabilityError(error, normalized);
  if (!counted) {
    return {
      ...getMainModelFallbackStatus({ scope: normalized.scope, now }),
      counted: false,
      activated: false
    };
  }

  const state = getScopeState(normalized.scope);
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.lastFailureStatus = Number(error?.response?.status || 0);
  state.lastError = safeErrorText(error);

  const immediateFallback = isImmediateFallbackFailure(error);
  const activationThreshold = immediateFallback ? 1 : getFailureThreshold(normalized.scope);

  let activated = false;
  if (!isFallbackActive({ scope: normalized.scope, now }) && state.consecutiveFailures >= activationThreshold) {
    const cooldownMs = getCooldownMs(normalized.scope);
    state.fallbackUntil = cooldownMs > 0 ? (now + cooldownMs) : PERMANENT_FALLBACK_UNTIL;
    state.lastActivatedAt = now;
    activated = true;
    console.warn(`[main-model-fallback:${normalized.scope}] activated backup model after repeated request failures`, {
      scope: normalized.scope,
      fallbackModel: getFallbackModelName(normalized.scope),
      failureThreshold: activationThreshold,
      immediateFallback,
      cooldownMs
    });
  }

  return {
    ...getMainModelFallbackStatus({ scope: normalized.scope, now }),
    counted: true,
    activated,
    immediateFallback
  };
}

function recordMainModelSuccess(meta = {}, options = null) {
  const normalized = normalizeScopeOptions(options);
  const now = normalized.now ?? Date.now();
  expireFallbackIfNeeded(normalized.scope, now);

  if (meta && meta.usingFallback) {
    return getMainModelFallbackStatus({ scope: normalized.scope, now });
  }

  const state = getScopeState(normalized.scope);
  state.consecutiveFailures = 0;
  state.lastFailureAt = 0;
  state.lastFailureStatus = 0;
  state.lastError = '';
  return getMainModelFallbackStatus({ scope: normalized.scope, now });
}

module.exports = {
  ADMIN_SHARED_FALLBACK_SCOPE,
  DEFAULT_FALLBACK_SCOPE,
  isFallbackActive,
  isImmediateFallbackFailure,
  isMainModelAvailabilityError,
  resolveMainModelConfig,
  resolveForcedFallbackMainModelConfig,
  recordMainModelFailure,
  recordMainModelSuccess,
  getMainModelFallbackStatus,
  resetMainModelFallbackState
};
