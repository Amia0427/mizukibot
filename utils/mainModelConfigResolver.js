const config = require('../config');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  resolveMainModelConfig
} = require('./mainModelFallback');

const warnedConfigKeys = new Set();

function normalizeText(value) {
  return String(value || '').trim();
}

function applyIfOverrideMissing(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key) && target[key] !== undefined) return;
  target[key] = value;
}

function pickConfiguredNumber(primary, fallback) {
  const n = Number(primary);
  return Number.isFinite(n) ? primary : fallback;
}

function pickConfiguredText(primary, fallback) {
  const text = normalizeText(primary);
  return text ? text : fallback;
}

function pickTextWithSource(candidates = [], fallbackValue = '', fallbackSource = '') {
  for (const candidate of candidates) {
    const value = normalizeText(candidate?.value);
    if (value) {
      return {
        value,
        source: normalizeText(candidate?.source) || 'unknown'
      };
    }
  }
  return {
    value: normalizeText(fallbackValue),
    source: normalizeText(fallbackSource) || 'empty'
  };
}

function warnOnce(key = '', message = '', details = {}) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey || warnedConfigKeys.has(normalizedKey)) return;
  warnedConfigKeys.add(normalizedKey);
  console.warn(message, details);
}

function getAdminUserIdSet() {
  return new Set(
    (Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );
}

function isAdminMainModelUser(userId = '', options = {}) {
  const normalizedUserId = normalizeText(userId);
  return getAdminUserIdSet().has(normalizedUserId);
}

function shouldBypassMainModelFallback(userId = '', options = {}) {
  return false;
}

function resolveRoleAwareMainModelConfig(userId = '', overrides = null, options = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  const isAdmin = isAdminMainModelUser(userId, options);
  const resolved = {
    ...base
  };
  const adminConfigWarnings = [];

  applyIfOverrideMissing(resolved, 'temperature', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_TEMPERATURE, config.AI_TEMPERATURE) : config.AI_TEMPERATURE);
  applyIfOverrideMissing(resolved, 'topP', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_TOP_P, config.AI_TOP_P) : config.AI_TOP_P);
  applyIfOverrideMissing(resolved, 'maxTokens', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_MAX_TOKENS, config.AI_MAX_TOKENS) : config.AI_MAX_TOKENS);
  applyIfOverrideMissing(resolved, 'retries', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_RETRIES, config.AI_RETRIES) : config.AI_RETRIES);
  applyIfOverrideMissing(resolved, 'reasoningEffort', isAdmin ? pickConfiguredText(config.ADMIN_AI_REASONING_EFFORT, config.AI_REASONING_EFFORT) : config.AI_REASONING_EFFORT);
  applyIfOverrideMissing(resolved, 'topK', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_TOP_K, config.AI_TOP_K) : config.AI_TOP_K);
  applyIfOverrideMissing(resolved, 'topA', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_TOP_A, config.AI_TOP_A) : config.AI_TOP_A);
  applyIfOverrideMissing(resolved, 'repetitionPenalty', isAdmin ? pickConfiguredNumber(config.ADMIN_AI_REPETITION_PENALTY, config.AI_REPETITION_PENALTY) : config.AI_REPETITION_PENALTY);

  const modelPick = pickTextWithSource([
    { value: base.model, source: 'override.model' },
    { value: isAdmin ? config.ADMIN_AI_MODEL : '', source: 'ADMIN_AI_MODEL' },
    { value: config.AI_MODEL, source: 'AI_MODEL' }
  ], 'gpt-5.4', 'hardcoded:gpt-5.4');
  const providerPick = pickTextWithSource([
    { value: base.provider, source: 'override.provider' },
    { value: isAdmin ? config.ADMIN_API_PROVIDER : '', source: 'ADMIN_API_PROVIDER' },
    { value: config.API_PROVIDER, source: 'API_PROVIDER' }
  ], '', 'empty');
  const apiBaseUrlPick = pickTextWithSource([
    { value: base.apiBaseUrl, source: 'override.apiBaseUrl' },
    { value: isAdmin ? config.ADMIN_API_BASE_URL : '', source: 'ADMIN_API_BASE_URL' },
    { value: config.API_BASE_URL, source: 'API_BASE_URL' }
  ], '', 'empty');
  const apiKeyPick = pickTextWithSource([
    { value: base.apiKey, source: 'override.apiKey' },
    { value: isAdmin ? config.ADMIN_API_KEY : '', source: 'ADMIN_API_KEY' },
    { value: config.API_KEY, source: 'API_KEY' }
  ], '', 'empty');

  if (isAdmin && !normalizeText(base.model) && !normalizeText(config.ADMIN_AI_MODEL)) {
    adminConfigWarnings.push('ADMIN_AI_MODEL_missing_using_default_model');
  }
  if (isAdmin && !normalizeText(base.apiBaseUrl) && !normalizeText(config.ADMIN_API_BASE_URL)) {
    adminConfigWarnings.push('ADMIN_API_BASE_URL_missing_using_default_endpoint');
  }
  if (isAdmin && !normalizeText(base.apiKey) && !normalizeText(config.ADMIN_API_KEY)) {
    adminConfigWarnings.push('ADMIN_API_KEY_missing_using_default_key');
  }
  for (const warning of adminConfigWarnings) {
    warnOnce(`main-model:${warning}`, `[main-model] ${warning}`, {
      userId: normalizeText(userId),
      modelSource: modelPick.source,
      apiBaseUrlSource: apiBaseUrlPick.source,
      apiKeySource: apiKeyPick.source
    });
  }

  return {
    ...resolved,
    model: modelPick.value || 'gpt-5.4',
    provider: providerPick.value || '',
    apiBaseUrl: apiBaseUrlPick.value,
    apiKey: apiKeyPick.value,
    __mainModelUserRole: isAdmin ? 'admin' : 'user',
    __mainModelSource: modelPick.source,
    __mainProviderSource: providerPick.source,
    __mainApiBaseUrlSource: apiBaseUrlPick.source,
    __mainApiKeySource: apiKeyPick.source,
    __adminDedicatedModelConfigured: isAdmin ? Boolean(normalizeText(base.model) || normalizeText(config.ADMIN_AI_MODEL)) : null,
    __adminConfigWarnings: adminConfigWarnings
  };
}

function resolveUserScopedMainModelConfig(userId = '', overrides = null, options = {}) {
  const primaryConfig = resolveRoleAwareMainModelConfig(userId, overrides, options);
  const scope = isAdminMainModelUser(userId, options)
    ? ADMIN_SHARED_FALLBACK_SCOPE
    : undefined;
  return resolveMainModelConfig(primaryConfig, { scope });
}

module.exports = {
  isAdminMainModelUser,
  shouldBypassMainModelFallback,
  resolveRoleAwareMainModelConfig,
  resolveUserScopedMainModelConfig
};
