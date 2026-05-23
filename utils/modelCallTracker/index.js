const path = require('path');
const config = require('../../config');
const { getApiProvider } = require('../modelProvider');
const {
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync
} = require('../logRotation');
const {
  pickModelRouteDiagnosticFields,
  safeHost
} = require('../modelRouteDiagnostics');
const {
  normalizeErrorCode,
  normalizeText,
  nowIso,
  safeClone
} = require('./common');
const { createModelCallLogWriter } = require('./logFile');
const { summarizePromptCaching } = require('./promptCaching');
const { summarizeRequest } = require('./requestSummary');
const { extractResponseModel, extractUsage } = require('./usage');

const MAX_RECENT_MODEL_CALLS = 200;
const MODEL_CALL_LOG_FILE = path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');

let recentModelCalls = [];
let sequence = 0;
const { appendModelCallLog, flushModelCallLogsSync } = createModelCallLogWriter({
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync,
  modelCallLogFile: MODEL_CALL_LOG_FILE
});

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
    prompt_integrity: requestSummary.prompt_integrity || null,
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
    prompt_integrity: cloned.prompt_integrity,
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
