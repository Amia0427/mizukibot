const fs = require('fs');
const path = require('path');
const config = require('../../config');

const CACHE_STATS_SCHEMA_VERSION = 'main_reply_cache_stats_v1';
const MAIN_REPLY_MODEL_CALL_SOURCES = Object.freeze([
  'v2_assistant_message',
  'v2_streaming_reply'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTokenCount(value) {
  const n = toFiniteNumber(value);
  return n === null ? null : Math.max(0, Math.floor(n));
}

function ratio(numerator, denominator) {
  const top = toFiniteNumber(numerator);
  const bottom = toFiniteNumber(denominator);
  if (top === null || bottom === null || bottom <= 0) return null;
  return Number((top / bottom).toFixed(4));
}

function sumKnown(values = []) {
  return values.reduce((total, value) => total + (toFiniteNumber(value) || 0), 0);
}

function readJsonLineFileRows(filePath = '', limit = 200) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return [];
  const raw = fs.readFileSync(normalizedPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-Math.max(1, Number(limit) || 200)).map((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function resolveModelCallLogFile(options = {}) {
  return normalizeText(options.logFile || options.modelCallLogFile)
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
}

function flushPendingModelCallLogRows(logFile = '') {
  try {
    const { flushBatchedLogWritesSync } = require('../logRotation');
    flushBatchedLogWritesSync(logFile);
  } catch (_) {}
}

function readModelCallLogRows(options = {}) {
  const logFile = resolveModelCallLogFile(options);
  flushPendingModelCallLogRows(logFile);
  return readJsonLineFileRows(logFile, options.readLimit || 5000);
}

function normalizePromptCaching(row = {}) {
  const promptCaching = row.prompt_caching && typeof row.prompt_caching === 'object' ? row.prompt_caching : {};
  return {
    openaiPromptCacheKey: normalizeText(promptCaching.openai_prompt_cache_key || promptCaching.openaiPromptCacheKey || row.prompt_cache_key),
    openaiPromptCacheRetention: normalizeText(promptCaching.openai_prompt_cache_retention || promptCaching.openaiPromptCacheRetention || row.prompt_cache_retention),
    openaiPromptCacheEnabled: promptCaching.openai_prompt_cache_enabled === true
      || promptCaching.openaiPromptCacheEnabled === true
      || Boolean(promptCaching.openai_prompt_cache_key || promptCaching.openaiPromptCacheKey || row.prompt_cache_key),
    anthropicBeta: normalizeText(promptCaching.anthropic_beta || promptCaching.anthropicBeta),
    anthropicPromptCachingBetaEnabled: promptCaching.prompt_caching_beta_enabled === true
      || promptCaching.anthropicPromptCachingBetaEnabled === true,
    systemBreakpoints: toTokenCount(promptCaching.system_cache_breakpoints),
    messageBreakpoints: toTokenCount(promptCaching.message_cache_breakpoints),
    toolBreakpoints: toTokenCount(promptCaching.tool_cache_breakpoints),
    totalBreakpoints: toTokenCount(promptCaching.total_cache_breakpoints)
  };
}

function normalizeUsageForCacheStats(row = {}) {
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  return {
    inputTokens: toTokenCount(
      usage.prompt_tokens
      ?? usage.input_tokens
      ?? usage.promptTokens
      ?? usage.inputTokens
    ),
    outputTokens: toTokenCount(
      usage.completion_tokens
      ?? usage.output_tokens
      ?? usage.completionTokens
      ?? usage.outputTokens
    ),
    totalTokens: toTokenCount(usage.total_tokens ?? usage.totalTokens),
    cacheReadTokens: toTokenCount(
      usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.promptCacheHitTokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.promptTokensDetails?.cachedTokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.inputTokensDetails?.cachedTokens
    ),
    cacheCreationTokens: toTokenCount(
      usage.cache_creation_input_tokens
      ?? usage.cacheCreationInputTokens
      ?? usage.prompt_cache_miss_tokens
      ?? usage.promptCacheMissTokens
      ?? usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.promptTokensDetails?.cacheWriteTokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? usage.inputTokensDetails?.cacheWriteTokens
    )
  };
}

function normalizeMainReplyCacheCall(row = {}) {
  const promptCaching = normalizePromptCaching(row);
  const usage = normalizeUsageForCacheStats(row);
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheCreationTokens = usage.cacheCreationTokens;
  const totalBreakpoints = promptCaching.totalBreakpoints ?? sumKnown([
    promptCaching.systemBreakpoints,
    promptCaching.messageBreakpoints,
    promptCaching.toolBreakpoints
  ]);

  return {
    ts: normalizeText(row.ts || row.completed_at || row.started_at),
    id: normalizeText(row.id),
    status: normalizeText(row.status),
    source: normalizeText(row.source),
    provider: normalizeText(row.provider),
    model: normalizeText(row.model),
    host: normalizeText(row.api_base_url_host || row.host || row.model_route_diagnostic?.apiBaseUrlHost),
    route: normalizeText(row.top_route_type || row.model_route_diagnostic?.topRouteType),
    routeDebugKey: normalizeText(row.route_debug_key || row.model_route_diagnostic?.routeDebugKey),
    routePolicyKey: normalizeText(row.route_policy_key || row.model_route_diagnostic?.routePolicyKey),
    dispatchBranch: normalizeText(row.dispatch_branch || row.model_route_diagnostic?.branch),
    promptCache: {
      openaiKeyPresent: Boolean(promptCaching.openaiPromptCacheKey),
      openaiRetention: promptCaching.openaiPromptCacheRetention,
      openaiEnabled: promptCaching.openaiPromptCacheEnabled,
      anthropicBetaEnabled: promptCaching.anthropicPromptCachingBetaEnabled,
      anthropicBeta: promptCaching.anthropicBeta,
      breakpoints: totalBreakpoints,
      systemBreakpoints: promptCaching.systemBreakpoints,
      messageBreakpoints: promptCaching.messageBreakpoints,
      toolBreakpoints: promptCaching.toolBreakpoints
    },
    tokens: {
      input: inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      cacheRead: cacheReadTokens,
      cacheCreation: cacheCreationTokens
    },
    ratios: {
      cacheReadToInput: ratio(cacheReadTokens, inputTokens),
      cacheCreationToInput: ratio(cacheCreationTokens, inputTokens)
    },
    attempts: toTokenCount(row.attempts),
    statusCode: toTokenCount(row.status_code),
    durationMs: toTokenCount(row.duration_ms),
    finalErrorCode: normalizeText(row.final_error_code || row.finalErrorCode),
    error: normalizeText(row.error).slice(0, 240)
  };
}

function isMainReplyModelCall(row = {}) {
  return MAIN_REPLY_MODEL_CALL_SOURCES.includes(normalizeText(row.source));
}

function hasPromptCacheConfigured(call = {}) {
  return Boolean(
    call.promptCache?.openaiEnabled
    || call.promptCache?.openaiKeyPresent
    || call.promptCache?.anthropicBetaEnabled
    || Number(call.promptCache?.breakpoints || 0) > 0
  );
}

function buildCallCacheSignals(call = {}) {
  const signals = [];
  const provider = normalizeText(call.provider);
  const inputTokens = toTokenCount(call.tokens?.input);
  const cacheReadTokens = toTokenCount(call.tokens?.cacheRead);
  const cacheCreationTokens = toTokenCount(call.tokens?.cacheCreation);
  const breakpoints = toTokenCount(call.promptCache?.breakpoints) || 0;

  if (call.status && call.status !== 'succeeded') {
    signals.push('call_failed');
  }
  if (!provider) {
    signals.push('missing_provider');
  }
  if (!normalizeText(call.model)) {
    signals.push('missing_model');
  }
  if (!normalizeText(call.route)) {
    signals.push('missing_route');
  }
  if (inputTokens === null) {
    signals.push('missing_usage_input_tokens');
  }
  if (cacheReadTokens === null && cacheCreationTokens === null) {
    signals.push('missing_cache_usage_tokens');
  }
  if (provider === 'anthropic') {
    if (breakpoints <= 0) signals.push('anthropic_cache_breakpoints_zero');
    if (!call.promptCache?.anthropicBetaEnabled && breakpoints > 0) {
      signals.push('anthropic_prompt_cache_beta_missing');
    }
  }
  if (provider === 'openai_compatible' && !call.promptCache?.openaiKeyPresent) {
    signals.push('openai_prompt_cache_key_missing');
  }
  if (hasPromptCacheConfigured(call) && inputTokens > 0 && !cacheReadTokens) {
    signals.push(cacheCreationTokens > 0 ? 'cache_warmup_no_read_tokens' : 'cache_configured_but_no_read_tokens');
  }
  if (!hasPromptCacheConfigured(call) && inputTokens > 0 && !cacheReadTokens && !cacheCreationTokens) {
    signals.push('no_prompt_cache_config_detected');
  }
  if (call.finalErrorCode) {
    signals.push(`error_${call.finalErrorCode}`);
  }
  if (/prompt[_ -]?cache|cache[_ -]?control|anthropic-beta|unsupported/i.test(call.error || '')) {
    signals.push('cache_schema_error_text');
  }
  return [...new Set(signals)];
}

function buildCacheStatsDiagnostic(options = {}) {
  const readLimit = Math.max(1, Number(options.readLimit || options.logReadLimit || 5000) || 5000);
  const callLimit = Math.max(1, Number(options.limit || options.callLimit || 50) || 50);
  const logFile = resolveModelCallLogFile(options);
  const allRows = Array.isArray(options.rows)
    ? options.rows
    : readModelCallLogRows({ ...options, logFile, readLimit });
  const mainReplyRows = allRows
    .filter(isMainReplyModelCall)
    .slice(-callLimit);
  const calls = mainReplyRows
    .map(normalizeMainReplyCacheCall)
    .map((call) => ({
      ...call,
      signals: buildCallCacheSignals(call)
    }));
  const totals = calls.reduce((acc, call) => {
    acc.calls += 1;
    if (call.status === 'succeeded') acc.succeeded += 1;
    if (call.status && call.status !== 'succeeded') acc.failed += 1;
    if (call.tokens.input !== null || call.tokens.cacheRead !== null || call.tokens.cacheCreation !== null) acc.withUsage += 1;
    if (hasPromptCacheConfigured(call)) acc.withPromptCacheConfig += 1;
    if ((call.tokens.cacheRead || 0) > 0) acc.withCacheRead += 1;
    if ((call.tokens.cacheCreation || 0) > 0) acc.withCacheCreation += 1;
    acc.breakpoints += call.promptCache.breakpoints || 0;
    acc.inputTokens += call.tokens.input || 0;
    acc.outputTokens += call.tokens.output || 0;
    acc.cacheReadTokens += call.tokens.cacheRead || 0;
    acc.cacheCreationTokens += call.tokens.cacheCreation || 0;
    return acc;
  }, {
    calls: 0,
    succeeded: 0,
    failed: 0,
    withUsage: 0,
    withPromptCacheConfig: 0,
    withCacheRead: 0,
    withCacheCreation: 0,
    breakpoints: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
  const signalCounts = {};
  for (const call of calls) {
    for (const signal of call.signals) {
      signalCounts[signal] = (signalCounts[signal] || 0) + 1;
    }
  }
  const latest = calls.length > 0 ? calls[calls.length - 1] : null;
  const anomalies = Object.entries(signalCounts)
    .filter(([signal]) => signal !== 'cache_warmup_no_read_tokens')
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));

  return {
    schemaVersion: CACHE_STATS_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    logFile,
    logWindow: `last_${callLimit}_main_reply_model_calls`,
    sources: MAIN_REPLY_MODEL_CALL_SOURCES.slice(),
    rowsRead: allRows.length,
    mainReplyRows: mainReplyRows.length,
    latest,
    totals: {
      ...totals,
      cacheReadRatio: ratio(totals.cacheReadTokens, totals.inputTokens),
      cacheCreationRatio: ratio(totals.cacheCreationTokens, totals.inputTokens),
      cacheActivityRatio: ratio(totals.cacheReadTokens + totals.cacheCreationTokens, totals.inputTokens)
    },
    signals: {
      counts: signalCounts,
      anomalies,
      noRecentMainReplyCalls: calls.length === 0,
      latestSignals: latest ? latest.signals : []
    },
    calls
  };
}

module.exports = {
  CACHE_STATS_SCHEMA_VERSION,
  buildCacheStatsDiagnostic,
  readModelCallLogRows
};
