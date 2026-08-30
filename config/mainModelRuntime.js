const MAIN_MODEL_SLOT_COUNT = 4;

function normalizeText(value) {
  return String(value || '').trim();
}

function buildSlotConfig(slot, pick) {
  const prefix = `MAIN_MODEL_${slot}`;
  const apiBaseUrl = pick(`${prefix}_API_BASE_URL`, '');
  const apiKey = pick(`${prefix}_API_KEY`, '');
  const model = pick(`${prefix}_MODEL`, '');
  const provider = pick(`${prefix}_API_PROVIDER`, '');
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
  const apiBaseUrl = pick('API_BASE_URL', 'https://api2.gemai.cc/v1/chat/completions');
  const apiKey = pick('API_KEY', '');
  const model = pick('AI_MODEL', 'gemini-3-pro-preview');
  const provider = pick('API_PROVIDER', '');
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

function buildMainModelRuntimeConfig({ pick }) {
  const slotConfigs = [];
  for (let slot = 1; slot <= MAIN_MODEL_SLOT_COUNT; slot += 1) {
    const config = buildSlotConfig(slot, pick);
    if (config) slotConfigs.push(config);
  }

  const hasSlotOne = slotConfigs.some((item) => item.slot === 1);
  const configs = hasSlotOne ? slotConfigs : [buildLegacyConfig(pick), ...slotConfigs].filter(Boolean);

  return {
    MAIN_MODEL_CONFIGS: configs,
    MAIN_MODEL_POOL_CONFIGURED: slotConfigs.length > 0
  };
}

module.exports = {
  MAIN_MODEL_SLOT_COUNT,
  buildMainModelRuntimeConfig
};
