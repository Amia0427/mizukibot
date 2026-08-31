const MAIN_MODEL_ENV_KEY_PATTERN = /^MAIN_MODEL_([1-9]\d*)_(?:API_BASE_URL|API_KEY|MODEL|API_PROVIDER)$/;

function normalizeText(value) {
  return String(value || '').trim();
}

function discoverMainModelSlots(env = process.env) {
  return [...new Set(
    Object.keys(env)
      .map((key) => {
        const match = key.match(MAIN_MODEL_ENV_KEY_PATTERN);
        return match ? Number(match[1]) : null;
      })
      .filter((slot) => Number.isSafeInteger(slot))
  )].sort((left, right) => left - right);
}

function buildSlotConfig(slot, pick) {
  const prefix = `MAIN_MODEL_${slot}`;
  const apiBaseUrl = normalizeText(pick(`${prefix}_API_BASE_URL`, ''));
  const apiKey = normalizeText(pick(`${prefix}_API_KEY`, ''));
  const model = normalizeText(pick(`${prefix}_MODEL`, ''));
  const provider = normalizeText(pick(`${prefix}_API_PROVIDER`, ''));
  if (!apiBaseUrl || !apiKey || !model) return null;

  return {
    id: `slot_${slot}`,
    slot,
    apiBaseUrl,
    apiKey,
    model,
    provider,
    __mainModelSource: `${prefix}_MODEL`,
    __mainProviderSource: provider ? `${prefix}_API_PROVIDER` : 'auto',
    __mainApiBaseUrlSource: `${prefix}_API_BASE_URL`,
    __mainApiKeySource: `${prefix}_API_KEY`
  };
}

function buildLegacyConfig(pick) {
  const apiBaseUrl = normalizeText(pick('API_BASE_URL', 'https://api2.gemai.cc/v1/chat/completions'));
  const apiKey = normalizeText(pick('API_KEY', ''));
  const model = normalizeText(pick('AI_MODEL', 'gemini-3-pro-preview'));
  const provider = normalizeText(pick('API_PROVIDER', ''));
  if (!apiBaseUrl || !apiKey || !model) return null;

  return {
    id: 'legacy',
    slot: 'legacy',
    apiBaseUrl,
    apiKey,
    model,
    provider,
    __mainModelSource: 'AI_MODEL',
    __mainProviderSource: provider ? 'API_PROVIDER' : 'auto',
    __mainApiBaseUrlSource: 'API_BASE_URL',
    __mainApiKeySource: 'API_KEY'
  };
}

function buildMainModelRuntimeConfig({ pick, env = process.env }) {
  const slotConfigs = discoverMainModelSlots(env)
    .map((slot) => buildSlotConfig(slot, pick))
    .filter(Boolean);

  const hasSlotOne = slotConfigs.some((item) => item.slot === 1);
  const configs = hasSlotOne ? slotConfigs : [buildLegacyConfig(pick), ...slotConfigs].filter(Boolean);

  return {
    MAIN_MODEL_CONFIGS: configs,
    MAIN_MODEL_POOL_CONFIGURED: slotConfigs.length > 0
  };
}

module.exports = {
  discoverMainModelSlots,
  buildMainModelRuntimeConfig
};
