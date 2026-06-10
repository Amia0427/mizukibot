const config = require('../config');
const { setEnvPairs, maskSecret } = require('../utils/envFile');
const { isUnsafeHttpUrl, assertSafeModelEndpoint } = require('../utils/networkSafety');

const MODEL_PRESETS = Array.isArray(config.MODEL_OPTIONS) && config.MODEL_OPTIONS.length
  ? config.MODEL_OPTIONS
  : ['gpt-5.4', 'gpt-5.1-codex-mini', 'gpt-4.1', 'gpt-4o-mini'];

const IMAGE_MODEL_PRESETS = Array.isArray(config.IMAGE_MODEL_OPTIONS) && config.IMAGE_MODEL_OPTIONS.length
  ? config.IMAGE_MODEL_OPTIONS
  : ['[official]gemini-3.1-flash-image-preview', 'gpt-image-1'];

function resolveSecretInput(submitted, current) {
  const next = String(submitted || '').trim();
  return next || String(current || '').trim();
}

function validateExternalApiBaseUrl(label, value, { required = false } = {}) {
  const url = String(value || '').trim();
  if (!url) {
    return required ? `${label} cannot be empty` : '';
  }
  if (!/^https?:\/\//i.test(url)) return `${label} must start with http/https`;
  if (isUnsafeHttpUrl(url)) return `${label} cannot point to localhost, private, or metadata networks`;
  return '';
}

async function getSettingsEndpointError(next = {}, options = {}) {
  const endpoints = [
    ['API_BASE_URL', next.api_base_url],
    ['AI_FALLBACK_API_BASE_URL', next.ai_fallback_api_base_url],
    ['AI_ROUTER_BASE_URL', next.ai_router_base_url],
    ['MEMORY_API_BASE_URL', next.memory_api_base_url],
    ['IMAGE_API_BASE_URL', next.image_api_base_url]
  ];

  for (const [name, value] of endpoints) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    try {
      await assertSafeModelEndpoint(raw, {
        allowLocalHttp: Boolean(config.MODEL_ENDPOINT_ALLOW_LOCAL_HTTP),
        lookup: options.lookup
      });
    } catch (error) {
      return `${name} is not an allowed model endpoint: ${error?.message || String(error)}`;
    }
  }
  return '';
}

function persistSettings(next) {
  setEnvPairs({
    API_KEY: next.api_key,
    API_BASE_URL: next.api_base_url,
    AI_MODEL: next.ai_model,
    AI_FALLBACK_ENABLED: String(next.ai_fallback_enabled),
    AI_FALLBACK_MODEL: next.ai_fallback_model,
    AI_FALLBACK_API_BASE_URL: next.ai_fallback_api_base_url,
    AI_FALLBACK_API_KEY: next.ai_fallback_api_key,
    AI_FALLBACK_FAILURE_THRESHOLD: String(next.ai_fallback_failure_threshold),
    AI_FALLBACK_COOLDOWN_MS: String(next.ai_fallback_cooldown_ms),
    AI_ROUTER_BASE_URL: next.ai_router_base_url,
    AI_ROUTER_API_KEY: next.ai_router_api_key,
    AI_ROUTER_MODEL: next.ai_router_model,
    MEMORY_MODEL: next.memory_model,
    MEMORY_API_BASE_URL: next.memory_api_base_url,
    MEMORY_API_KEY: next.memory_api_key,
    IMAGE_MODEL: next.image_model,
    IMAGE_API_BASE_URL: next.image_api_base_url,
    IMAGE_API_KEY: next.image_api_key,
    AI_TEMPERATURE: String(next.ai_temperature),
    AI_TOP_P: String(next.ai_top_p),
    AI_MAX_TOKENS: String(next.ai_max_tokens),
    AI_RETRIES: String(next.ai_retries),
    AI_STREAM_ENABLED: String(next.ai_stream_enabled),
    AI_STREAM_CHUNK_MS: String(next.ai_stream_chunk_ms),
    LLM_HUMANIZER_ENABLED: String(next.llm_humanizer_enabled)
  });

  process.env.API_KEY = next.api_key;
  process.env.API_BASE_URL = next.api_base_url;
  process.env.AI_MODEL = next.ai_model;
  process.env.AI_FALLBACK_ENABLED = String(next.ai_fallback_enabled);
  process.env.AI_FALLBACK_MODEL = next.ai_fallback_model;
  process.env.AI_FALLBACK_API_BASE_URL = next.ai_fallback_api_base_url;
  process.env.AI_FALLBACK_API_KEY = next.ai_fallback_api_key;
  process.env.AI_FALLBACK_FAILURE_THRESHOLD = String(next.ai_fallback_failure_threshold);
  process.env.AI_FALLBACK_COOLDOWN_MS = String(next.ai_fallback_cooldown_ms);
  process.env.AI_ROUTER_BASE_URL = next.ai_router_base_url;
  process.env.AI_ROUTER_API_KEY = next.ai_router_api_key;
  process.env.AI_ROUTER_MODEL = next.ai_router_model;
  process.env.MEMORY_MODEL = next.memory_model;
  process.env.MEMORY_API_BASE_URL = next.memory_api_base_url;
  process.env.MEMORY_API_KEY = next.memory_api_key;
  process.env.IMAGE_MODEL = next.image_model;
  process.env.IMAGE_API_BASE_URL = next.image_api_base_url;
  process.env.IMAGE_API_KEY = next.image_api_key;
  process.env.AI_TEMPERATURE = String(next.ai_temperature);
  process.env.AI_TOP_P = String(next.ai_top_p);
  process.env.AI_MAX_TOKENS = String(next.ai_max_tokens);
  process.env.AI_RETRIES = String(next.ai_retries);
  process.env.AI_STREAM_ENABLED = String(next.ai_stream_enabled);
  process.env.AI_STREAM_CHUNK_MS = String(next.ai_stream_chunk_ms);
  process.env.LLM_HUMANIZER_ENABLED = String(next.llm_humanizer_enabled);

  config.API_KEY = next.api_key;
  config.UNIFIED_API_KEY = next.api_key;
  config.API_BASE_URL = next.api_base_url;
  config.AI_MODEL = next.ai_model;
  config.AI_FALLBACK_ENABLED = next.ai_fallback_enabled;
  config.AI_FALLBACK_MODEL = next.ai_fallback_model;
  config.AI_FALLBACK_API_BASE_URL = next.ai_fallback_api_base_url;
  config.AI_FALLBACK_API_KEY = next.ai_fallback_api_key;
  config.AI_FALLBACK_FAILURE_THRESHOLD = next.ai_fallback_failure_threshold;
  config.AI_FALLBACK_COOLDOWN_MS = next.ai_fallback_cooldown_ms;
  config.AI_ROUTER_BASE_URL = next.ai_router_base_url;
  config.AI_ROUTER_API_KEY = next.ai_router_api_key;
  config.AI_ROUTER_MODEL = next.ai_router_model;
  config.MEMORY_MODEL = next.memory_model;
  config.MEMORY_API_BASE_URL = next.memory_api_base_url;
  config.MEMORY_API_KEY = next.memory_api_key;
  config.IMAGE_MODEL = next.image_model;
  config.IMAGE_API_BASE_URL = next.image_api_base_url;
  config.IMAGE_API_KEY = next.image_api_key;
  config.AI_TEMPERATURE = next.ai_temperature;
  config.AI_TOP_P = next.ai_top_p;
  config.AI_MAX_TOKENS = next.ai_max_tokens;
  config.AI_RETRIES = next.ai_retries;
  config.AI_STREAM_ENABLED = next.ai_stream_enabled;
  config.AI_STREAM_CHUNK_MS = next.ai_stream_chunk_ms;
  config.LLM_HUMANIZER_ENABLED = next.llm_humanizer_enabled;
}

function getCurrentSettings() {
  return {
    has_api_key: Boolean(String(config.API_KEY || '').trim()),
    api_key_masked: maskSecret(config.API_KEY || ''),
    has_ai_fallback_api_key: Boolean(String(config.AI_FALLBACK_API_KEY || '').trim()),
    ai_fallback_api_key_masked: maskSecret(config.AI_FALLBACK_API_KEY || ''),
    has_ai_router_api_key: Boolean(String(config.AI_ROUTER_API_KEY || '').trim()),
    ai_router_api_key_masked: maskSecret(config.AI_ROUTER_API_KEY || ''),
    has_memory_api_key: Boolean(String(config.MEMORY_API_KEY || '').trim()),
    memory_api_key_masked: maskSecret(config.MEMORY_API_KEY || ''),
    has_image_api_key: Boolean(String(config.IMAGE_API_KEY || '').trim()),
    image_api_key_masked: maskSecret(config.IMAGE_API_KEY || ''),
    api_base_url: String(config.API_BASE_URL || ''),
    ai_model: String(config.AI_MODEL || ''),
    ai_fallback_enabled: Boolean(config.AI_FALLBACK_ENABLED),
    ai_fallback_model: String(config.AI_FALLBACK_MODEL || ''),
    ai_fallback_api_base_url: String(config.AI_FALLBACK_API_BASE_URL || ''),
    ai_fallback_failure_threshold: Number(config.AI_FALLBACK_FAILURE_THRESHOLD ?? 3),
    ai_fallback_cooldown_ms: Number(config.AI_FALLBACK_COOLDOWN_MS ?? 600000),
    ai_router_base_url: String(config.AI_ROUTER_BASE_URL || ''),
    ai_router_model: String(config.AI_ROUTER_MODEL || ''),
    memory_model: String(config.MEMORY_MODEL || ''),
    memory_api_base_url: String(config.MEMORY_API_BASE_URL || ''),
    image_model: String(config.IMAGE_MODEL || ''),
    image_api_base_url: String(config.IMAGE_API_BASE_URL || ''),
    ai_temperature: Number(config.AI_TEMPERATURE ?? 0.6),
    ai_top_p: Number(config.AI_TOP_P ?? 0.92),
    ai_max_tokens: Number(config.AI_MAX_TOKENS ?? config.MAIN_REPLY_DEFAULT_MAX_TOKENS ?? 8192),
    ai_retries: Number(config.AI_RETRIES ?? 1),
    ai_stream_enabled: Boolean(config.AI_STREAM_ENABLED),
    ai_stream_chunk_ms: Number(config.AI_STREAM_CHUNK_MS ?? 900),
    llm_humanizer_enabled: Boolean(config.LLM_HUMANIZER_ENABLED),
    presets: { text_models: MODEL_PRESETS, image_models: IMAGE_MODEL_PRESETS }
  };
}

function parseGovernanceOptions(raw = {}) {
  const modeRaw = String(raw.mode || 'balanced').trim().toLowerCase();
  const actionRaw = String(raw.action || 'archive').trim().toLowerCase();
  return {
    userId: String(raw.user_id || raw.userId || '').trim(),
    mode: modeRaw === 'strict' ? 'strict' : 'balanced',
    action: actionRaw === 'delete' ? 'delete' : 'archive',
    minConfidence: Number(raw.min_confidence ?? raw.minConfidence ?? 0.72),
    topicTtlDays: Number(raw.topic_ttl_days ?? raw.topicTtlDays ?? 21),
    dedupeThreshold: Number(raw.dedupe_threshold ?? raw.dedupeThreshold ?? 0.9)
  };
}

module.exports = {
  getCurrentSettings,
  getSettingsEndpointError,
  IMAGE_MODEL_PRESETS,
  MODEL_PRESETS,
  parseGovernanceOptions,
  persistSettings,
  resolveSecretInput,
  validateExternalApiBaseUrl
};
