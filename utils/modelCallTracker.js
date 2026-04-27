const { getApiProvider } = require('./modelProvider');

const MAX_RECENT_MODEL_CALLS = 200;

let recentModelCalls = [];
let sequence = 0;

function normalizeText(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function flattenContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => flattenContentText(part)).join('\n');
  }
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return flattenContentText(content.content);
  if (content.type === 'image_url') {
    return String(content?.image_url?.url || content?.url || '');
  }
  return '';
}

function hasCacheControl(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.cache_control
    && typeof value.cache_control === 'object'
    && String(value.cache_control.type || '').trim()
  );
}

function countCacheControlBlocks(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;

  let total = hasCacheControl(value) ? 1 : 0;
  if (Array.isArray(value.content)) {
    total += value.content.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (value.function && typeof value.function === 'object') {
    total += countCacheControlBlocks(value.function);
  }
  return total;
}

function containsMemoryMarker(text) {
  const input = String(text || '');
  if (!input) return false;
  return /\[Memory\]|\[Profile\]|\[Summary\]|长期记忆|记忆注入/i.test(input);
}

function summarizeRequest(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemText = flattenContentText(request.system);
  const combinedText = [
    systemText,
    ...messages.map((msg) => flattenContentText(msg?.content))
  ].join('\n');
  const explicitMessageCount = Number(request.message_count);
  const explicitToolCount = Number(request.tool_count);

  return {
    model: normalizeText(request.model),
    stream: Boolean(request.stream),
    max_tokens: Number.isFinite(Number(request.max_tokens))
      ? Math.floor(Number(request.max_tokens))
      : null,
    message_count: Number.isFinite(explicitMessageCount)
      ? Math.max(0, Math.floor(explicitMessageCount))
      : messages.length + (systemText ? 1 : 0),
    tool_count: Number.isFinite(explicitToolCount)
      ? Math.max(0, Math.floor(explicitToolCount))
      : (Array.isArray(request.tools) ? request.tools.length : 0),
    memory_injected: request.memory_injected !== undefined
      ? Boolean(request.memory_injected)
      : containsMemoryMarker(combinedText)
  };
}

function summarizePromptCaching(request = {}, requestHeaders = {}) {
  const headers = requestHeaders && typeof requestHeaders === 'object' ? requestHeaders : {};
  const anthropicBeta = String(headers['anthropic-beta'] || headers['Anthropic-Beta'] || '').trim();
  const systemBlocks = Array.isArray(request.system) ? request.system : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const anthropicBetaFlags = anthropicBeta
    ? anthropicBeta.toLowerCase().split(',').map((part) => part.trim()).filter(Boolean)
    : [];

  const systemCacheBreakpoints = systemBlocks.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  const messageCacheBreakpoints = messages.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  const toolCacheBreakpoints = tools.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);

  return {
    anthropic_beta: anthropicBeta || null,
    prompt_caching_beta_enabled: anthropicBetaFlags.includes('prompt-caching-2024-07-31'),
    system_cache_breakpoints: systemCacheBreakpoints,
    message_cache_breakpoints: messageCacheBreakpoints,
    tool_cache_breakpoints: toolCacheBreakpoints,
    total_cache_breakpoints: systemCacheBreakpoints + messageCacheBreakpoints + toolCacheBreakpoints
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const promptTokens = Number(
    raw.prompt_tokens
    ?? raw.input_tokens
    ?? raw.promptTokens
    ?? raw.inputTokens
    ?? raw.input_token_count
  );
  const completionTokens = Number(
    raw.completion_tokens
    ?? raw.output_tokens
    ?? raw.completionTokens
    ?? raw.outputTokens
    ?? raw.output_token_count
  );
  const totalTokens = Number(
    raw.total_tokens
    ?? raw.totalTokens
  );
  const cacheReadInputTokens = Number(
    raw.cache_read_input_tokens
    ?? raw.cacheReadInputTokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens
    ?? raw.input_tokens_details?.cached_tokens
    ?? raw.inputTokensDetails?.cachedTokens
  );
  const cacheCreationInputTokens = Number(
    raw.cache_creation_input_tokens
    ?? raw.cacheCreationInputTokens
    ?? raw.prompt_tokens_details?.cache_write_tokens
    ?? raw.promptTokensDetails?.cacheWriteTokens
    ?? raw.input_tokens_details?.cache_write_tokens
    ?? raw.inputTokensDetails?.cacheWriteTokens
  );
  const cacheCreation = raw.cache_creation && typeof raw.cache_creation === 'object'
    ? safeClone(raw.cache_creation, {})
    : null;

  const hasPrompt = Number.isFinite(promptTokens);
  const hasCompletion = Number.isFinite(completionTokens);
  const hasTotal = Number.isFinite(totalTokens);
  const hasCacheRead = Number.isFinite(cacheReadInputTokens);
  const hasCacheCreation = Number.isFinite(cacheCreationInputTokens) || Boolean(cacheCreation);
  if (!hasPrompt && !hasCompletion && !hasTotal && !hasCacheRead && !hasCacheCreation) return null;

  return {
    prompt_tokens: hasPrompt ? Math.floor(promptTokens) : null,
    completion_tokens: hasCompletion ? Math.floor(completionTokens) : null,
    cache_read_input_tokens: hasCacheRead ? Math.floor(cacheReadInputTokens) : null,
    cache_creation_input_tokens: Number.isFinite(cacheCreationInputTokens) ? Math.floor(cacheCreationInputTokens) : null,
    cache_creation: cacheCreation,
    total_tokens: hasTotal
      ? Math.floor(totalTokens)
      : ((hasPrompt || hasCompletion)
        ? Math.floor((hasPrompt ? promptTokens : 0) + (hasCompletion ? completionTokens : 0))
        : null)
  };
}

function extractUsage(response) {
  const data = response?.data ?? response;
  return (
    normalizeUsage(data?.usage)
    || normalizeUsage(data?.response_metadata?.usage)
    || normalizeUsage(data?.response_metadata?.tokenUsage)
    || normalizeUsage(data?.usage_metadata)
    || null
  );
}

function extractResponseModel(response) {
  const data = response?.data ?? response;
  return normalizeText(
    data?.model
    || data?.model_name
    || data?.response_metadata?.model_name
    || data?.response_metadata?.model
  );
}

function capRecentCalls() {
  if (recentModelCalls.length <= MAX_RECENT_MODEL_CALLS) return;
  recentModelCalls = recentModelCalls.slice(0, MAX_RECENT_MODEL_CALLS);
}

function startModelCall(meta = {}) {
  sequence += 1;
  const requestSummary = summarizeRequest(meta.request || {});
  const promptCaching = summarizePromptCaching(meta.request || {}, meta.requestHeaders || {});
  const model = normalizeText(meta.model || requestSummary.model);
  const provider = normalizeText(
    meta.provider
    || getApiProvider(meta.url || '', model)
  ) || 'openai_compatible';

  const record = {
    id: `model_call_${Date.now()}_${sequence}`,
    status: 'running',
    source: normalizeText(meta.source || 'app') || 'app',
    phase: normalizeText(meta.phase),
    purpose: normalizeText(meta.purpose),
    provider,
    model,
    stream: requestSummary.stream,
    max_tokens: requestSummary.max_tokens,
    message_count: requestSummary.message_count,
    tool_count: requestSummary.tool_count,
    memory_injected: Boolean(
      meta.memoryInjected !== undefined
        ? meta.memoryInjected
        : requestSummary.memory_injected
    ),
    prompt_caching: promptCaching,
    user_id: normalizeText(meta.userId),
    task_id: normalizeText(meta.taskId),
    route_policy_key: normalizeText(meta.routePolicyKey),
    top_route_type: normalizeText(meta.topRouteType),
    user_role: normalizeText(meta.userRole),
    model_source: normalizeText(meta.modelSource),
    api_base_url_source: normalizeText(meta.apiBaseUrlSource),
    api_key_source: normalizeText(meta.apiKeySource),
    main_fallback_scope: normalizeText(meta.mainFallbackScope),
    main_fallback_active: Boolean(meta.mainFallbackActive),
    admin_dedicated_model_configured: meta.adminDedicatedModelConfigured === undefined
      ? null
      : Boolean(meta.adminDedicatedModelConfigured),
    attempts: 0,
    usage: null,
    error: '',
    started_at: nowIso(),
    completed_at: null,
    duration_ms: null
  };

  recentModelCalls.unshift(record);
  capRecentCalls();
  return record.id;
}

function findRecord(id) {
  return recentModelCalls.find((item) => item.id === id) || null;
}

function finalizeRecord(id, patch = {}) {
  const record = findRecord(id);
  if (!record) return null;

  const completedAt = nowIso();
  const startedAt = Date.parse(record.started_at);
  const completedTs = Date.parse(completedAt);

  record.status = normalizeText(patch.status || record.status) || record.status;
  record.completed_at = completedAt;
  record.duration_ms = Number.isFinite(startedAt) && Number.isFinite(completedTs)
    ? Math.max(0, completedTs - startedAt)
    : null;
  record.attempts = Math.max(1, Number(patch.attempts || record.attempts || 1));
  record.error = normalizeText(patch.error);

  if (
    Object.prototype.hasOwnProperty.call(patch, 'request')
    || Object.prototype.hasOwnProperty.call(patch, 'requestHeaders')
  ) {
    record.prompt_caching = summarizePromptCaching(
      patch.request || {},
      patch.requestHeaders || {}
    );
  }

  const usage = patch.usage || extractUsage(patch.response);
  if (usage) record.usage = usage;

  const actualModel = extractResponseModel(patch.response);
  if (actualModel) record.model = actualModel;

  return safeClone(record, {});
}

function finishModelCall(id, meta = {}) {
  return finalizeRecord(id, {
    ...meta,
    status: 'succeeded',
    error: ''
  });
}

function failModelCall(id, error, meta = {}) {
  const message = normalizeText(
    error?.response?.data?.error?.message
    || error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || error
  ) || 'unknown error';

  return finalizeRecord(id, {
    ...meta,
    status: 'failed',
    error: message
  });
}

function listRecentModelCalls(limit = 50) {
  const max = Math.max(1, Math.min(MAX_RECENT_MODEL_CALLS, Number(limit) || 50));
  return safeClone(recentModelCalls.slice(0, max), []);
}

function resetModelCallTracker() {
  recentModelCalls = [];
  sequence = 0;
}

module.exports = {
  startModelCall,
  finishModelCall,
  failModelCall,
  listRecentModelCalls,
  resetModelCallTracker
};
