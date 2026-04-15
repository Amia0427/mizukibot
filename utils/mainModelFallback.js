const config = require('../config');

const PERMANENT_FALLBACK_UNTIL = -1;

const state = {
  consecutiveFailures: 0,
  fallbackUntil: 0,
  lastActivatedAt: 0,
  lastFailureAt: 0,
  lastFailureStatus: 0,
  lastError: ''
};

function normalizeText(value) {
  return String(value || '').trim();
}

function getFailureThreshold() {
  const raw = Number(config.AI_FALLBACK_FAILURE_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.max(1, Math.floor(raw));
}

function getCooldownMs() {
  const raw = Number(config.AI_FALLBACK_COOLDOWN_MS);
  if (!Number.isFinite(raw)) return 600000;
  if (raw <= 0) return 0;
  return Math.max(1000, Math.floor(raw));
}

function getFallbackModelName() {
  return normalizeText(config.AI_FALLBACK_MODEL);
}

function isFallbackConfigured() {
  return Boolean(config.AI_FALLBACK_ENABLED) && Boolean(getFallbackModelName());
}

function resetMainModelFallbackState() {
  state.consecutiveFailures = 0;
  state.fallbackUntil = 0;
  state.lastActivatedAt = 0;
  state.lastFailureAt = 0;
  state.lastFailureStatus = 0;
  state.lastError = '';
}

function expireFallbackIfNeeded(now = Date.now()) {
  if (!isFallbackConfigured()) {
    resetMainModelFallbackState();
    return false;
  }

  if (!state.fallbackUntil || state.fallbackUntil === PERMANENT_FALLBACK_UNTIL || now < state.fallbackUntil) return false;

  state.consecutiveFailures = 0;
  state.fallbackUntil = 0;
  state.lastActivatedAt = 0;
  return true;
}

function isFallbackActive(now = Date.now()) {
  if (!isFallbackConfigured()) return false;
  expireFallbackIfNeeded(now);
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

function isMainModelAvailabilityError(error) {
  if (!isFallbackConfigured()) return false;
  return Boolean(error);
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

function resolveMainModelConfig(baseConfig = null) {
  const primaryConfig = buildPrimaryConfig(baseConfig);
  if (!isFallbackActive()) {
    return {
      ...primaryConfig,
      __mainFallbackActive: false
    };
  }

  return {
    ...primaryConfig,
    model: getFallbackModelName() || primaryConfig.model,
    apiBaseUrl: normalizeText(config.AI_FALLBACK_API_BASE_URL || primaryConfig.apiBaseUrl),
    apiKey: normalizeText(config.AI_FALLBACK_API_KEY || primaryConfig.apiKey),
    __mainFallbackActive: true
  };
}

function resolveForcedFallbackMainModelConfig(baseConfig = null) {
  const primaryConfig = buildPrimaryConfig(baseConfig);
  return {
    ...primaryConfig,
    model: getFallbackModelName() || primaryConfig.model,
    apiBaseUrl: normalizeText(config.AI_FALLBACK_API_BASE_URL || primaryConfig.apiBaseUrl),
    apiKey: normalizeText(config.AI_FALLBACK_API_KEY || primaryConfig.apiKey),
    __mainFallbackActive: true,
    __mainFallbackForced: true
  };
}

function getMainModelFallbackStatus(now = Date.now()) {
  expireFallbackIfNeeded(now);
  return {
    enabled: Boolean(config.AI_FALLBACK_ENABLED),
    configured: isFallbackConfigured(),
    active: isFallbackActive(now),
    permanent: state.fallbackUntil === PERMANENT_FALLBACK_UNTIL,
    consecutiveFailures: state.consecutiveFailures,
    fallbackUntil: state.fallbackUntil,
    lastActivatedAt: state.lastActivatedAt,
    lastFailureAt: state.lastFailureAt,
    lastFailureStatus: state.lastFailureStatus,
    lastError: state.lastError,
    failureThreshold: getFailureThreshold(),
    cooldownMs: getCooldownMs(),
    fallbackModel: getFallbackModelName()
  };
}

function recordMainModelFailure(error) {
  const now = Date.now();
  expireFallbackIfNeeded(now);

  const counted = isMainModelAvailabilityError(error);
  if (!counted) {
    return {
      ...getMainModelFallbackStatus(now),
      counted: false,
      activated: false
    };
  }

  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.lastFailureStatus = Number(error?.response?.status || 0);
  state.lastError = safeErrorText(error);

  let activated = false;
  if (!isFallbackActive(now) && state.consecutiveFailures >= getFailureThreshold()) {
    const cooldownMs = getCooldownMs();
    state.fallbackUntil = cooldownMs > 0 ? (now + cooldownMs) : PERMANENT_FALLBACK_UNTIL;
    state.lastActivatedAt = now;
    activated = true;
    console.warn('[main-model-fallback] activated backup model after repeated request failures');
  }

  return {
    ...getMainModelFallbackStatus(now),
    counted: true,
    activated
  };
}

function recordMainModelSuccess(meta = {}) {
  const now = Date.now();
  expireFallbackIfNeeded(now);

  if (meta && meta.usingFallback) {
    return getMainModelFallbackStatus(now);
  }

  state.consecutiveFailures = 0;
  state.lastFailureAt = 0;
  state.lastFailureStatus = 0;
  state.lastError = '';
  return getMainModelFallbackStatus(now);
}

module.exports = {
  isMainModelAvailabilityError,
  resolveMainModelConfig,
  resolveForcedFallbackMainModelConfig,
  recordMainModelFailure,
  recordMainModelSuccess,
  getMainModelFallbackStatus,
  resetMainModelFallbackState
};
