const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { readModelCallLogRows } = require('./cacheStats');

const TRUNCATION_SCHEMA_VERSION = 'main_reply_truncation_diagnostic_v1';
const DEFAULT_LIMIT = 50;
const DEFAULT_READ_LIMIT = 5000;
const MAIN_REPLY_MODEL_CALL_SOURCES = new Set([
  'v2_assistant_message',
  'v2_streaming_reply'
]);
const UPSTREAM_RESET_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'TIMEOUT',
  'NETWORK_ERROR'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveEventMs(row = {}) {
  const raw = normalizeText(
    row.ts
    || row.recordedAt
    || row.completed_at
    || row.completedAt
    || row.started_at
    || row.startedAt
  );
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countBy(items = [], keySelector = null) {
  const counts = {};
  for (const item of items) {
    const key = normalizeText(typeof keySelector === 'function' ? keySelector(item) : item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countsToTopList(counts = {}) {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function readJsonLineFileRows(filePath = '', limit = DEFAULT_READ_LIMIT) {
  const target = normalizeText(filePath);
  if (!target || !fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-Math.max(1, Number(limit) || DEFAULT_READ_LIMIT))
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function resolveModelCallLogFile(options = {}) {
  return normalizeText(options.logFile || options.modelCallLogFile)
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
}

function resolveTraceLogFile(options = {}) {
  return normalizeText(options.traceFile || options.requestTraceLogFile)
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'request-trace.ndjson');
}

function readTraceRows(options = {}) {
  if (Array.isArray(options.traceRows)) return options.traceRows;
  return readJsonLineFileRows(resolveTraceLogFile(options), options.traceReadLimit || options.readLimit || DEFAULT_READ_LIMIT);
}

function isMainReplyModelCall(row = {}) {
  const source = normalizeText(row.source);
  if (MAIN_REPLY_MODEL_CALL_SOURCES.has(source)) return true;
  const topRouteType = normalizeText(row.top_route_type || row.topRouteType || row.model_route_diagnostic?.topRouteType);
  const route = normalizeText(
    row.route_debug_key
    || row.routeDebugKey
    || row.route_policy_key
    || row.routePolicyKey
    || row.model_route_diagnostic?.routeDebugKey
    || row.model_route_diagnostic?.routePolicyKey
  );
  const dispatchBranch = normalizeText(row.dispatch_branch || row.dispatchBranch || row.model_route_diagnostic?.branch);
  const triggerBranch = normalizeText(row.trigger_branch || row.triggerBranch || row.model_route_diagnostic?.triggerBranch);
  return topRouteType === 'direct_chat'
    && (/direct_chat|chat\/default|text_chat/i.test(route)
      || /direct_reply|draft_reply/i.test(dispatchBranch)
      || /direct_reply|draft_reply/i.test(triggerBranch));
}

function normalizeFinishReason(value = '') {
  const raw = normalizeText(value);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'max_tokens' || lower === 'max_output_tokens') return 'MAX_TOKENS';
  if (lower === 'length' || lower.includes('max_tokens') || lower.includes('max output')) return 'MAX_TOKENS';
  if (lower === 'stream_closed_without_terminal_event') return 'stream_closed_without_terminal_event';
  return raw;
}

function isMaxTokensFinishReason(value = '') {
  return normalizeFinishReason(value) === 'MAX_TOKENS';
}

function isNoTerminalEventFinishReason(value = '') {
  return normalizeFinishReason(value) === 'stream_closed_without_terminal_event';
}

function traceHasFinishReason(traceEvents = [], predicate = () => false) {
  return traceEvents.some((event) => predicate(event.finishReason || event.finish_reason));
}

function traceHasNoTerminalEvent(traceEvents = []) {
  return traceEvents.some((event) => {
    const stage = normalizeLower(event.stage || event.tracePhase || event.type);
    return isNoTerminalEventFinishReason(event.finishReason || event.finish_reason)
      || (stage === 'http_client_success' && event.streamDoneSeen === false);
  });
}

function normalizeErrorCode(value = '') {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : '';
}

function isUpstreamResetSignal(call = {}, traceEvents = []) {
  const code = normalizeErrorCode(call.final_error_code || call.finalErrorCode);
  const error = normalizeLower(call.error);
  const traceHasUpstreamReset = traceEvents.some((event) => {
    const eventCode = normalizeErrorCode(event.finalErrorCode || event.final_error_code);
    const eventError = normalizeLower(event.error || event.message);
    return UPSTREAM_RESET_CODES.has(eventCode)
      || /econnreset|socket hang up|connection reset|network|timed?\s*out|timeout|aborted/.test(eventError);
  });
  if (UPSTREAM_RESET_CODES.has(code)) return true;
  if (/econnreset|socket hang up|connection reset|network|timed?\s*out|timeout|aborted/.test(error)) return true;
  if (traceHasUpstreamReset && normalizeLower(call.status) !== 'succeeded') return true;
  if (normalizeLower(call.status) === 'succeeded') return false;
  if (code) return false;
  return traceHasUpstreamReset;
}

function isSendLayerFailureSignal(traceEvents = []) {
  return traceEvents.some((event) => {
    const stage = normalizeLower(event.stage || event.tracePhase || event.type);
    const finalErrorCode = normalizeLower(event.finalErrorCode || event.final_error_code);
    const sent = event.sent;
    return stage === 'reply_send_failure'
      || stage === 'final_reply_send_done' && sent === false
      || stage === 'request_complete' && sent === false
      || finalErrorCode === 'reply_send_failed'
      || finalErrorCode === 'stale_reply_discarded'
      || finalErrorCode.includes('send_failed');
  });
}

function isPotentialTruncationCall(call = {}, traceEvents = []) {
  if (!isMainReplyModelCall(call)) return false;
  const finishReason = normalizeFinishReason(call.finish_reason || call.finishReason);
  const status = normalizeLower(call.status);
  if (isMaxTokensFinishReason(finishReason) || traceHasFinishReason(traceEvents, isMaxTokensFinishReason)) return true;
  if (isNoTerminalEventFinishReason(finishReason) || traceHasNoTerminalEvent(traceEvents)) return true;
  if (isUpstreamResetSignal(call, traceEvents)) return true;
  if (isSendLayerFailureSignal(traceEvents)) return true;
  return status === 'failed';
}

function buildTraceIndex(traceRows = []) {
  const byRequestId = new Map();
  for (const event of traceRows) {
    const requestId = normalizeText(event.requestId || event.request_id);
    if (!requestId) continue;
    if (!byRequestId.has(requestId)) byRequestId.set(requestId, []);
    byRequestId.get(requestId).push(event);
  }
  for (const events of byRequestId.values()) {
    events.sort((a, b) => resolveEventMs(a) - resolveEventMs(b));
  }
  return byRequestId;
}

function dedupeModelRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      normalizeText(row.id),
      normalizeText(row.ts || row.completed_at || row.started_at),
      normalizeText(row.request_id || row.requestId),
      normalizeText(row.status),
      normalizeText(row.finish_reason || row.finishReason),
      normalizeText(row.final_error_code || row.finalErrorCode)
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function classifyTruncationCall(call = {}, traceEvents = []) {
  const finishReason = normalizeFinishReason(call.finish_reason || call.finishReason);
  const finalErrorCode = normalizeText(call.final_error_code || call.finalErrorCode);
  const signals = [];
  if (isMaxTokensFinishReason(finishReason) || traceHasFinishReason(traceEvents, isMaxTokensFinishReason)) {
    signals.push('max_tokens_finish_reason');
  }
  if (isNoTerminalEventFinishReason(finishReason) || traceHasNoTerminalEvent(traceEvents)) {
    signals.push('stream_closed_without_terminal_event');
  }
  if (isUpstreamResetSignal(call, traceEvents)) signals.push('upstream_stream_reset_or_disconnect');
  if (isSendLayerFailureSignal(traceEvents)) signals.push('local_send_layer_failure');
  if (normalizeLower(call.status) === 'failed') signals.push('model_call_failed');
  if (finalErrorCode) signals.push(`error_${finalErrorCode}`);

  let primaryReason = 'unknown';
  let category = 'unknown';
  if (signals.includes('max_tokens_finish_reason')) {
    primaryReason = 'MAX_TOKENS';
    category = 'max_tokens';
  } else if (signals.includes('upstream_stream_reset_or_disconnect')) {
    primaryReason = 'UPSTREAM_DISCONNECT';
    category = 'upstream_disconnect';
  } else if (signals.includes('stream_closed_without_terminal_event')) {
    primaryReason = 'NO_TERMINAL_EVENT';
    category = 'no_terminal_event';
  } else if (signals.includes('local_send_layer_failure')) {
    primaryReason = 'LOCAL_SEND_LAYER';
    category = 'local_send_layer';
  } else if (signals.includes('model_call_failed')) {
    primaryReason = 'MODEL_CALL_FAILED';
    category = 'model_call_failed';
  }

  return {
    primaryReason,
    category,
    signals: [...new Set(signals)]
  };
}

function summarizeTraceForCall(traceEvents = []) {
  const sendEvents = traceEvents
    .filter((event) => /reply_send|final_reply_send|request_complete/i.test(normalizeText(event.stage || event.tracePhase || event.type)))
    .slice(-5)
    .map((event) => ({
      recordedAt: normalizeText(event.recordedAt || event.ts),
      stage: normalizeText(event.stage || event.tracePhase || event.type),
      sent: typeof event.sent === 'boolean' ? event.sent : null,
      finalErrorCode: normalizeText(event.finalErrorCode || event.final_error_code),
      durationMs: toFiniteNumber(event.durationMs ?? event.duration_ms, null)
    }));
  const httpEvents = traceEvents
    .filter((event) => /^http_client_/i.test(normalizeText(event.stage || event.tracePhase || event.type)))
    .slice(-5)
    .map((event) => ({
      recordedAt: normalizeText(event.recordedAt || event.ts),
      stage: normalizeText(event.stage || event.tracePhase || event.type),
      statusCode: toFiniteNumber(event.statusCode ?? event.status_code, null),
      finalErrorCode: normalizeText(event.finalErrorCode || event.final_error_code),
      finishReason: normalizeFinishReason(event.finishReason || event.finish_reason),
      streamDoneSeen: typeof event.streamDoneSeen === 'boolean' ? event.streamDoneSeen : null,
      retryable: typeof event.retryable === 'boolean' ? event.retryable : null
    }));
  return {
    eventCount: traceEvents.length,
    lastStage: traceEvents.length > 0
      ? normalizeText(traceEvents[traceEvents.length - 1].stage || traceEvents[traceEvents.length - 1].tracePhase || traceEvents[traceEvents.length - 1].type)
      : '',
    sendEvents,
    httpEvents
  };
}

function normalizeSample(call = {}, traceEvents = []) {
  const classification = classifyTruncationCall(call, traceEvents);
  const usage = call.usage && typeof call.usage === 'object' ? call.usage : {};
  return {
    id: normalizeText(call.id),
    ts: normalizeText(call.ts || call.completed_at || call.started_at),
    requestId: normalizeText(call.request_id || call.requestId),
    status: normalizeText(call.status),
    source: normalizeText(call.source),
    provider: normalizeText(call.provider),
    model: normalizeText(call.model),
    host: normalizeText(call.api_base_url_host || call.host || call.model_route_diagnostic?.apiBaseUrlHost),
    stream: call.stream === true,
    maxTokens: toFiniteNumber(call.max_tokens ?? call.maxTokens, null),
    completionTokens: toFiniteNumber(
      usage.completion_tokens
      ?? usage.output_tokens
      ?? usage.completionTokens
      ?? usage.outputTokens,
      null
    ),
    finishReason: normalizeFinishReason(call.finish_reason || call.finishReason),
    finalErrorCode: normalizeText(call.final_error_code || call.finalErrorCode),
    statusCode: toFiniteNumber(call.status_code ?? call.statusCode, null),
    durationMs: toFiniteNumber(call.duration_ms ?? call.durationMs, null),
    routeDebugKey: normalizeText(call.route_debug_key || call.routeDebugKey || call.model_route_diagnostic?.routeDebugKey),
    routePolicyKey: normalizeText(call.route_policy_key || call.routePolicyKey || call.model_route_diagnostic?.routePolicyKey),
    dispatchBranch: normalizeText(call.dispatch_branch || call.dispatchBranch || call.model_route_diagnostic?.branch),
    triggerBranch: normalizeText(call.trigger_branch || call.triggerBranch || call.model_route_diagnostic?.triggerBranch),
    primaryReason: classification.primaryReason,
    category: classification.category,
    signals: classification.signals,
    error: normalizeText(call.error).slice(0, 240),
    trace: summarizeTraceForCall(traceEvents)
  };
}

function buildMainReplyTruncationDiagnostic(options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const readLimit = Math.max(limit, Number(options.readLimit || options.logReadLimit || DEFAULT_READ_LIMIT) || DEFAULT_READ_LIMIT);
  const modelCallLogFile = resolveModelCallLogFile(options);
  const traceFile = resolveTraceLogFile(options);
  const modelRows = Array.isArray(options.rows) || Array.isArray(options.modelCallRows)
    ? (options.rows || options.modelCallRows)
    : readModelCallLogRows({ ...options, logFile: modelCallLogFile, readLimit });
  const traceRows = readTraceRows({ ...options, readLimit });
  const traceIndex = buildTraceIndex(traceRows);
  const uniqueModelRows = dedupeModelRows(modelRows);

  const candidateRows = uniqueModelRows
    .filter(isMainReplyModelCall)
    .map((call) => ({
      call,
      traceEvents: traceIndex.get(normalizeText(call.request_id || call.requestId)) || []
    }))
    .filter(({ call, traceEvents }) => isPotentialTruncationCall(call, traceEvents));

  const samples = candidateRows
    .slice(-limit)
    .map(({ call, traceEvents }) => normalizeSample(call, traceEvents));
  const reasonCounts = countBy(samples, (sample) => sample.primaryReason);
  const categoryCounts = countBy(samples, (sample) => sample.category);
  const signalCounts = {};
  for (const sample of samples) {
    for (const signal of sample.signals) {
      signalCounts[signal] = (signalCounts[signal] || 0) + 1;
    }
  }

  return {
    schemaVersion: TRUNCATION_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    modelCallLogFile,
    traceFile,
    window: `last_${limit}_main_reply_truncation_candidates`,
    rowsRead: modelRows.length,
    uniqueRowsRead: uniqueModelRows.length,
    traceRowsRead: traceRows.length,
    candidateRows: candidateRows.length,
    sampleCount: samples.length,
    sources: Array.from(MAIN_REPLY_MODEL_CALL_SOURCES),
    summary: {
      total: samples.length,
      latest: samples.length > 0 ? samples[samples.length - 1] : null,
      topReasons: countsToTopList(reasonCounts),
      topCategories: countsToTopList(categoryCounts),
      topSignals: countsToTopList(signalCounts),
      noRecentTruncationCandidates: samples.length === 0
    },
    samples
  };
}

module.exports = {
  TRUNCATION_SCHEMA_VERSION,
  buildMainReplyTruncationDiagnostic,
  classifyTruncationCall,
  dedupeModelRows,
  isMainReplyModelCall,
  normalizeFinishReason,
  readJsonLineFileRows
};
