const path = require('path');
const config = require('../config');
const { getApiProvider } = require('./modelProvider');
const {
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync
} = require('./logRotation');
const {
  pickModelRouteDiagnosticFields,
  safeHost
} = require('./modelRouteDiagnostics');

const MAX_RECENT_MODEL_CALLS = 200;
const MODEL_CALL_LOG_FILE = path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');

let recentModelCalls = [];
let sequence = 0;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeErrorCode(error = null) {
  const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
  if (Number.isFinite(status) && status > 0) return `http_${Math.floor(status)}`;
  const code = normalizeText(error?.code || error?.errorCode || error?.error_code);
  if (code) return code;
  const message = normalizeText(error?.message || error).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('network')) return 'network_error';
  return message ? 'error' : '';
}

function nowIso() {
  return new Date().toISOString();
}

function appendModelCallLog(record = {}) {
  try {
    appendFileWithRotationBatched(MODEL_CALL_LOG_FILE, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8'
    });
  } catch (_) {}
}

function flushModelCallLogsSync() {
  try {
    return flushBatchedLogWritesSync(MODEL_CALL_LOG_FILE);
  } catch (_) {
    return false;
  }
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
    openai_prompt_cache_key: normalizeText(request.prompt_cache_key),
    openai_prompt_cache_retention: normalizeText(request.prompt_cache_retention),
    openai_prompt_cache_enabled: Boolean(
      normalizeText(request.prompt_cache_key)
      || normalizeText(request.prompt_cache_retention)
    ),
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
    ?? raw.prompt_cache_hit_tokens
    ?? raw.promptCacheHitTokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens
    ?? raw.input_tokens_details?.cached_tokens
    ?? raw.inputTokensDetails?.cachedTokens
  );
  const cacheCreationInputTokens = Number(
    raw.cache_creation_input_tokens
    ?? raw.cacheCreationInputTokens
    ?? raw.prompt_cache_miss_tokens
    ?? raw.promptCacheMissTokens
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
  const routeDiagnostics = pickModelRouteDiagnosticFields({
    ...(meta.modelRouteDiagnostic && typeof meta.modelRouteDiagnostic === 'object' ? meta.modelRouteDiagnostic : {}),
    routeDebugKey: meta.routeDebugKey,
    routePolicyKey: meta.routePolicyKey,
    topRouteType: meta.topRouteType,
    branch: meta.dispatchBranch,
    triggerBranch: meta.triggerBranch,
    provider,
    apiBaseUrl: meta.apiBaseUrl || meta.url,
    apiBaseUrlHost: meta.apiBaseUrlHost || safeHost(meta.apiBaseUrl || meta.url),
    model,
    modelSource: meta.modelSource,
    apiBaseUrlSource: meta.apiBaseUrlSource,
    apiKeySource: meta.apiKeySource,
    fallbackReason: meta.fallbackReason,
    fallbackScope: meta.mainFallbackScope,
    fallbackActive: meta.mainFallbackActive === true,
    fallbackForced: meta.mainFallbackForced === true
  });

  const record = {
    id: `model_call_${Date.now()}_${sequence}`,
    status: 'running',
    source: normalizeText(meta.source || 'app') || 'app',
    phase: normalizeText(meta.phase),
    purpose: normalizeText(meta.purpose),
    request_id: normalizeText(meta.requestId),
    trace_phase_seq: Number.isFinite(Number(meta.phaseSeq)) ? Math.max(0, Math.floor(Number(meta.phaseSeq))) : null,
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
    route_policy_key: routeDiagnostics.routePolicyKey,
    route_debug_key: routeDiagnostics.routeDebugKey,
    top_route_type: routeDiagnostics.topRouteType,
    dispatch_branch: routeDiagnostics.branch,
    trigger_branch: routeDiagnostics.triggerBranch,
    api_base_url: routeDiagnostics.apiBaseUrl,
    api_base_url_host: routeDiagnostics.apiBaseUrlHost,
    fallback_reason: routeDiagnostics.fallbackReason,
    model_route_diagnostic: routeDiagnostics,
    user_role: normalizeText(meta.userRole),
    model_source: routeDiagnostics.modelSource,
    api_base_url_source: routeDiagnostics.apiBaseUrlSource,
    api_key_source: routeDiagnostics.apiKeySource,
    main_fallback_scope: routeDiagnostics.fallbackScope,
    main_fallback_active: routeDiagnostics.fallbackActive,
    main_fallback_forced: routeDiagnostics.fallbackForced,
    admin_dedicated_model_configured: meta.adminDedicatedModelConfigured === undefined
      ? null
      : Boolean(meta.adminDedicatedModelConfigured),
    attempts: 0,
    usage: null,
    error: '',
    final_error_code: '',
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
  record.final_error_code = normalizeText(patch.final_error_code || patch.finalErrorCode || record.final_error_code);

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

  const cloned = safeClone(record, {});
  appendModelCallLog({
    ts: cloned.completed_at || nowIso(),
    id: cloned.id,
    status: cloned.status,
    source: cloned.source,
    phase: cloned.phase,
    purpose: cloned.purpose,
    request_id: cloned.request_id,
    trace_phase_seq: cloned.trace_phase_seq,
    provider: cloned.provider,
    host: safeHost(patch?.url || patch?.requestUrl || ''),
    model: cloned.model,
    stream: cloned.stream,
    max_tokens: cloned.max_tokens,
    message_count: cloned.message_count,
    tool_count: cloned.tool_count,
    memory_injected: cloned.memory_injected,
    prompt_caching: cloned.prompt_caching,
    usage: cloned.usage,
    user_id: cloned.user_id,
    user_role: cloned.user_role,
    route_policy_key: cloned.route_policy_key,
    route_debug_key: cloned.route_debug_key,
    top_route_type: cloned.top_route_type,
    dispatch_branch: cloned.dispatch_branch,
    trigger_branch: cloned.trigger_branch,
    api_base_url: cloned.api_base_url,
    api_base_url_host: cloned.api_base_url_host,
    fallback_reason: cloned.fallback_reason,
    model_route_diagnostic: cloned.model_route_diagnostic,
    model_source: cloned.model_source,
    api_base_url_source: cloned.api_base_url_source,
    api_key_source: cloned.api_key_source,
    main_fallback_scope: cloned.main_fallback_scope,
    main_fallback_active: cloned.main_fallback_active,
    main_fallback_forced: cloned.main_fallback_forced,
    admin_dedicated_model_configured: cloned.admin_dedicated_model_configured,
    attempts: cloned.attempts,
    duration_ms: cloned.duration_ms,
    error: cloned.error,
    final_error_code: cloned.final_error_code,
    status_code: Number(
      patch?.response?.status
      || patch?.status
      || patch?.error?.response?.status
      || 0
    ) || null
  });
  return cloned;
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
    error: message,
    final_error_code: normalizeErrorCode(error)
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
  flushModelCallLogsSync,
  listRecentModelCalls,
  resetModelCallTracker
};
