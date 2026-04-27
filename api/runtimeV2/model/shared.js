const config = require('../../../config');
const crypto = require('crypto');
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

function ensureResponsesUrl(url) {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/responses$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, '/responses');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/responses`;
  return normalized;
}

function normalizeOpenAIMainApiMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'responses' || normalized === 'response') return 'responses';
  if (normalized === 'chat' || normalized === 'chat_completion' || normalized === 'chat_completions') {
    return 'chat_completions';
  }
  return 'auto';
}

function resolveOpenAIMainProtocol(apiBaseUrl = '', options = {}) {
  const mode = normalizeOpenAIMainApiMode(options.apiMode || config.OPENAI_MAIN_API_MODE);
  if (mode === 'responses') return 'responses';
  if (mode === 'chat_completions') return 'chat_completions';

  const normalized = String(apiBaseUrl || '').replace(/\/+$/, '').toLowerCase();
  if (/\/responses$/i.test(normalized)) return 'responses';
  return 'chat_completions';
}

function ensureOpenAIMainUrl(apiBaseUrl = '', options = {}) {
  const protocol = resolveOpenAIMainProtocol(apiBaseUrl, options);
  return protocol === 'responses'
    ? ensureResponsesUrl(apiBaseUrl)
    : ensureChatCompletionsUrl(apiBaseUrl);
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

function getOptionalPositiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function getOptionalUnitFloat(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

function getOptionalPositiveNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function getTopK(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.topK !== undefined
    ? overrides.topK
    : config.AI_TOP_K;
  return getOptionalPositiveInteger(raw);
}

function getTopA(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.topA !== undefined
    ? overrides.topA
    : config.AI_TOP_A;
  return getOptionalUnitFloat(raw);
}

function getRepetitionPenalty(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.repetitionPenalty !== undefined
    ? overrides.repetitionPenalty
    : config.AI_REPETITION_PENALTY;
  return getOptionalPositiveNumber(raw);
}

function getMaxTokens(defaultValue = 3500, overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.maxTokens !== undefined
    ? overrides.maxTokens
    : config.AI_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.max(64, Math.floor(n));
}

function getReasoningEffort(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.reasoningEffort !== undefined
    ? overrides.reasoningEffort
    : config.AI_REASONING_EFFORT;
  const normalized = String(raw == null ? 'high' : raw).trim().toLowerCase();
  if (!normalized) return 'high';
  if (['0', 'false', 'no', 'off', 'none', 'disabled', 'disable'].includes(normalized)) return '';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'high';
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

function normalizeOpenAIPromptCacheRetention(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'in_memory' || normalized === '24h' ? normalized : '';
}

function flattenTextForCacheFingerprint(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => flattenTextForCacheFingerprint(item)).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return flattenTextForCacheFingerprint(content.content);
  return '';
}

function getStablePromptFingerprintText(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  const stableTexts = [
    String(config.SYSTEM_PROMPT || '').trim(),
    String(require('../../../utils/promptSecurity').buildSecuritySystemPrompt?.() || '').trim(),
    String(require('../../../utils/personaModules').loadPersonaModuleText?.('core_baseline') || '').trim()
  ].filter(Boolean);
  for (const stableText of stableTexts) {
    if (normalized === stableText) return stableText;
    if (normalized.startsWith(`${stableText}\n`)) return stableText;
  }
  return '';
}

function buildStablePromptFingerprint(messages = [], tools = []) {
  const stableMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const role = String(message?.role || '').trim().toLowerCase();
      return role === 'system' || role === 'developer';
    })
    .map((message) => ({
      role: String(message?.role || '').trim().toLowerCase(),
      text: getStablePromptFingerprintText(flattenTextForCacheFingerprint(message?.content))
    }))
    .filter((item) => item.text);
  const toolShapes = (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool;
      return {
        type: String(tool?.type || 'function').trim() || 'function',
        name: String(fn?.name || '').trim(),
        description: String(fn?.description || '').trim(),
        strict: typeof fn?.strict === 'boolean' ? fn.strict : null,
        parameters: fn?.parameters || null
      };
    })
    .filter((item) => item.name);
  return JSON.stringify({
    stableMessages,
    toolShapes
  });
}

function buildOpenAIPromptCacheKey(protocol, resolvedConfig = null, options = {}) {
  const model = getModelName(resolvedConfig);
  const routeType = String(
    options?.routeMeta?.topRouteType
    || options?.topRouteType
    || options?.trace?.topRouteType
    || ''
  ).trim();
  const prefix = String(config.OPENAI_PROMPT_CACHE_KEY_PREFIX || 'mizukibot:main').trim() || 'mizukibot:main';
  const namespaceHash = crypto
    .createHash('sha256')
    .update(prefix)
    .digest('hex')
    .slice(0, 8);
  const payload = JSON.stringify({
    namespaceHash,
    model,
    routeType,
    stablePrompt: buildStablePromptFingerprint(options.messages, options.tools)
  });
  const hash = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex')
    .slice(0, 24);
  return `mizukibot:main:${protocol}:${hash}`;
}

function applyOpenAIPromptCacheOptions(body, protocol, resolvedConfig = null, options = {}) {
  if (!body || typeof body !== 'object') return body;
  if (config.OPENAI_PROMPT_CACHE_ENABLED === false) return body;

  const nextBody = {
    ...body,
    prompt_cache_key: buildOpenAIPromptCacheKey(protocol, resolvedConfig, options)
  };
  const retention = normalizeOpenAIPromptCacheRetention(config.OPENAI_PROMPT_CACHE_RETENTION);
  if (retention) nextBody.prompt_cache_retention = retention;
  return nextBody;
}

function buildGenerationRequestBody(resolvedConfig = null, options = {}) {
  const protocol = String(options.protocol || 'chat_completions').trim() || 'chat_completions';
  const body = {
    model: getModelName(resolvedConfig),
    temperature: getTemperature(resolvedConfig),
    top_p: getTopP(resolvedConfig),
    messages: Array.isArray(options.messages) ? options.messages : [],
    max_tokens: getMaxTokens(options.defaultMaxTokens || 3500, resolvedConfig),
    reasoning_effort: getReasoningEffort(resolvedConfig),
    stream: Boolean(options.stream)
  };

  const topK = getTopK(resolvedConfig);
  if (topK !== undefined) body.top_k = topK;

  const topA = getTopA(resolvedConfig);
  if (topA !== undefined) body.top_a = topA;

  const repetitionPenalty = getRepetitionPenalty(resolvedConfig);
  if (repetitionPenalty !== undefined) body.repetition_penalty = repetitionPenalty;

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice || options.tool_choice || 'auto';
  }

  if (options.trace && typeof options.trace === 'object') {
    body.__trace = options.trace;
  }

  return applyOpenAIPromptCacheOptions(body, protocol, resolvedConfig, options);
}

function buildMainModelRequest(resolvedConfig = null, options = {}) {
  const apiBaseUrl = getApiBaseUrl(resolvedConfig);
  const protocol = resolveOpenAIMainProtocol(apiBaseUrl, options);
  return {
    protocol,
    url: ensureOpenAIMainUrl(apiBaseUrl, { apiMode: protocol }),
    body: buildGenerationRequestBody(resolvedConfig, {
      ...options,
      protocol
    })
  };
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
  buildMainModelRequest,
  buildGenerationRequestBody,
  buildImageModelConfig,
  ensureChatCompletionsUrl,
  ensureOpenAIMainUrl,
  ensureResponsesUrl,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRepetitionPenalty,
  getReasoningEffort,
  getRetries,
  getTemperature,
  getTopA,
  getTopK,
  getTopP,
  normalizeTextContent,
  resolveOpenAIMainProtocol,
  withMainModelFallback
};
