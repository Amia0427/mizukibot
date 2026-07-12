const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync
} = require('./logRotation');

let sequence = 0;
const phaseSeqByRequestId = new Map();
const MAX_TRACKED_REQUEST_PHASES = 5000;
const MAX_TRACE_TEXT_LENGTH = 400;
const TRACE_TEXT_FIELDS = new Set([
  'requestId', 'tracePhase', 'stage', 'source', 'messageId', 'groupId', 'userId', 'chatType',
  'category', 'type', 'node', 'threadId', 'routePolicyKey', 'routeDebugKey', 'topRouteType',
  'dispatchBranch', 'triggerBranch', 'purpose', 'provider', 'model', 'protocol', 'channel',
  'reason', 'triggerReason', 'action', 'failureType', 'failureStage', 'fallbackSource', 'fallbackReason', 'fallbackScope',
  'mainFallbackScope', 'apiBaseUrlHost', 'modelSource', 'apiBaseUrlSource', 'apiKeySource',
  'finalErrorCode', 'errorCode', 'concurrencyLane', 'concurrencyScope', 'foreground_lane',
  'foreground_request_id', 'inbound_lane', 'inbound_pool', 'inbound_request_id',
  'ignoreSessionLimitReason', 'executor', 'planner', 'apiBaseUrl', 'requestUrl',
  'retry', 'tool', 'toolName', 'replyPath', 'finishReason', 'mode', 'jobId', 'postReplyJobId',
  'decisionSource', 'plannerDecisionSource', 'plannerModel', 'plannerMode', 'unavailableReason',
  'needsMemoryReason', 'recallFacet', 'downgradeReason', 'relationship', 'fastPath'
]);
const TRACE_NUMBER_FIELDS = new Set([
  'phaseSeq', 'requestStartedAt', 'elapsedSinceRequestStartMs', 'durationMs', 'statusCode',
  'chunkIndex', 'chunkCount', 'chunkLength', 'messageLength', 'queueWaitMs', 'rawMessageTimestampMs', 'elapsedSinceHandlerStartMs',
  'lagFromMessageMs', 'foreground_active_admin', 'foreground_active_general',
  'foreground_active_total', 'foreground_wait_ms', 'inbound_active_admin',
  'inbound_active_general', 'inbound_active_total', 'inbound_wait_ms', 'attempt', 'retryCount',
  'maxRetry', 'pid', 'plannerMs', 'executorMs', 'streamMs', 'firstTokenMs', 'sendMs',
  'prepareMs', 'routeMs', 'dispatchMs', 'validateMs', 'persistMs', 'toolMs', 'maxAttempts',
  'allowedToolCount', 'plannerStepCount', 'tokens'
]);
const TRACE_BOOLEAN_FIELDS = new Set([
  'isAdmin', 'applied', 'success', 'ok', 'cache', 'richMessage', 'fallbackActive', 'fallbackForced',
  'mainFallbackActive', 'mainFallbackForced', 'privilegedPrivateChat', 'ignoreSessionLimit',
  'needsBackground', 'streamCompleted', 'retryable', 'saved', 'shouldPersistBridge',
  'shouldPersistJournal', 'shouldLearn', 'shouldEnqueuePostReplyJob', 'workerStarted',
  'stream', 'sent', 'streamDoneSeen', 'allowTools', 'shouldUseTools', 'plannerFallbackUsed',
  'hasContext', 'needsMemory', 'forceMemoryContext'
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function sanitizeTraceText(value) {
  let text = normalizeText(value instanceof Error ? value.message : value).slice(0, MAX_TRACE_TEXT_LENGTH);
  text = text
    .replace(/((?:^|[_-])(?:api_?key|access_?token|refresh_?token|token|client_?secret|secret|password)\s*=)[^\s,;}&]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b(?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|set-cookie|cookie|client[-_ ]?secret|password|secret)\b["']?\s*:\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/(["']?\b(?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|set-cookie|cookie|client[-_ ]?secret|password|secret)\b["']?\s*[:=]\s*)["']?([^"'\s,;}&]+)["']?/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api_?key|token|access_?token|refresh_?token|key|client_?secret|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@');
  return text;
}

function sanitizeTraceUrl(value) {
  try {
    const parsed = new URL(normalizeText(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
}

function serializeRequestTraceEvent(payload = {}) {
  const serialized = {};
  for (const field of TRACE_TEXT_FIELDS) {
    if (payload[field] === undefined || payload[field] === null) continue;
    const value = sanitizeTraceText(payload[field]);
    if (value) serialized[field] = value;
  }
  for (const field of ['apiBaseUrl', 'requestUrl']) {
    if (payload[field] === undefined || payload[field] === null) continue;
    const value = sanitizeTraceUrl(payload[field]);
    if (value) serialized[field] = value;
    else delete serialized[field];
  }
  for (const field of TRACE_NUMBER_FIELDS) {
    if (payload[field] === null) {
      serialized[field] = null;
      continue;
    }
    const value = Number(payload[field]);
    if (Number.isFinite(value)) serialized[field] = value;
  }
  for (const field of TRACE_BOOLEAN_FIELDS) {
    if (typeof payload[field] === 'boolean') serialized[field] = payload[field];
  }
  const error = payload.error || payload.rawErrorMessage;
  if (error) serialized.error = sanitizeTraceText(error);
  if (payload.modelRouteDiagnostic && typeof payload.modelRouteDiagnostic === 'object') {
    const diagnostic = serializeRequestTraceEvent(payload.modelRouteDiagnostic);
    if (Object.keys(diagnostic).length > 0) serialized.modelRouteDiagnostic = diagnostic;
  }
  if (payload.cache && typeof payload.cache === 'object') {
    const cache = {};
    const breakpoints = Number(payload.cache.anthropicCacheBreakpoints);
    if (Number.isFinite(breakpoints)) cache.anthropicCacheBreakpoints = breakpoints;
    for (const field of ['openaiPromptCacheKey', 'openaiPromptCacheRetention', 'anthropicPromptCacheTtl', 'anthropicBeta', 'anthropicOneHourCacheHeader', 'downgradeReason']) {
      const value = sanitizeTraceText(payload.cache[field]);
      if (value) cache[field] = value;
    }
    if (Object.keys(cache).length > 0) serialized.cache = cache;
  }
  for (const field of ['allowedToolNames', 'plannerTools']) {
    if (!Array.isArray(payload[field])) continue;
    serialized[field] = payload[field]
      .slice(0, 100)
      .map((value) => sanitizeTraceText(value).slice(0, 120))
      .filter(Boolean);
  }
  return serialized;
}

function stableHash(value = '') {
  return crypto
    .createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

function rememberRequestPhaseSeq(requestId = '', phaseSeq = 0) {
  const normalizedRequestId = normalizeText(requestId);
  if (!normalizedRequestId) return;
  if (phaseSeqByRequestId.has(normalizedRequestId)) phaseSeqByRequestId.delete(normalizedRequestId);
  phaseSeqByRequestId.set(normalizedRequestId, Math.max(0, Number(phaseSeq) || 0));
  while (phaseSeqByRequestId.size > MAX_TRACKED_REQUEST_PHASES) {
    const oldest = phaseSeqByRequestId.keys().next().value;
    if (!oldest) break;
    phaseSeqByRequestId.delete(oldest);
  }
}

function resolveTraceLogFile() {
  try {
    const config = require('../config');
    return path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'request-trace.ndjson');
  } catch (_) {
    return path.join(process.cwd(), 'data', 'request-trace.ndjson');
  }
}

function buildRequestId(input = {}) {
  const messageId = normalizeText(input.messageId || input.message_id);
  const groupId = normalizeText(input.groupId || input.group_id);
  const userId = normalizeText(input.userId || input.user_id);
  const chatType = normalizeText(input.chatType || input.messageType || 'group') || 'group';
  if (messageId || userId || groupId) {
    return `req_${stableHash([chatType, groupId, userId, messageId].join('|'))}`;
  }
  sequence += 1;
  return `req_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function normalizeRequestTrace(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const requestId = normalizeText(value.requestId || value.request_id);
  if (!requestId) return null;
  return value;
}

function createRequestTrace(input = {}) {
  const existing = normalizeRequestTrace(input.requestTrace || input.trace);
  if (existing) return existing;
  const requestId = normalizeText(input.requestId || input.request_id) || buildRequestId(input);
  return {
    requestId,
    phaseSeq: Math.max(0, Number(input.phaseSeq || input.phase_seq || 0) || 0),
    startedAt: Number(input.startedAt || Date.now()) || Date.now(),
    source: normalizeText(input.source || 'message_ingress') || 'message_ingress',
    messageId: normalizeText(input.messageId || input.message_id),
    groupId: normalizeText(input.groupId || input.group_id),
    userId: normalizeText(input.userId || input.user_id),
    chatType: normalizeText(input.chatType || input.messageType || 'group') || 'group',
    isAdmin: input.isAdmin === true
  };
}

function nextTracePhase(trace = null, phase = '', payload = {}) {
  const requestTrace = normalizeRequestTrace(trace);
  if (!requestTrace) return { ...payload };
  const requestId = normalizeText(requestTrace.requestId);
  const knownSeq = Math.max(0, Number(phaseSeqByRequestId.get(requestId) || 0) || 0);
  const traceSeq = Math.max(0, Number(requestTrace.phaseSeq || requestTrace.phase_seq || 0) || 0);
  const nextSeq = Math.max(knownSeq, traceSeq) + 1;
  rememberRequestPhaseSeq(requestId, nextSeq);
  requestTrace.phaseSeq = nextSeq;
  const tracePhase = normalizeText(phase || payload.tracePhase || payload.phase || payload.stage || 'unknown') || 'unknown';
  const now = Date.now();
  const startedAt = Number(requestTrace.startedAt || 0) || 0;
  return {
    requestId: requestTrace.requestId,
    phaseSeq: requestTrace.phaseSeq,
    tracePhase,
    requestStartedAt: startedAt || null,
    elapsedSinceRequestStartMs: startedAt > 0 ? Math.max(0, now - startedAt) : null,
    ...payload
  };
}

function currentTraceFields(trace = null, payload = {}) {
  const requestTrace = normalizeRequestTrace(trace);
  if (!requestTrace) return { ...payload };
  const now = Date.now();
  const startedAt = Number(requestTrace.startedAt || 0) || 0;
  return {
    requestId: requestTrace.requestId,
    phaseSeq: Math.max(0, Number(requestTrace.phaseSeq || requestTrace.phase_seq || 0) || 0),
    requestStartedAt: startedAt || null,
    elapsedSinceRequestStartMs: startedAt > 0 ? Math.max(0, now - startedAt) : null,
    ...payload
  };
}

function cloneTraceForMeta(trace = null) {
  const requestTrace = normalizeRequestTrace(trace);
  if (!requestTrace) return null;
  return {
    requestId: normalizeText(requestTrace.requestId),
    phaseSeq: Math.max(0, Number(requestTrace.phaseSeq || requestTrace.phase_seq || 0) || 0),
    startedAt: Number(requestTrace.startedAt || 0) || Date.now(),
    source: normalizeText(requestTrace.source),
    messageId: normalizeText(requestTrace.messageId || requestTrace.message_id),
    groupId: normalizeText(requestTrace.groupId || requestTrace.group_id),
    userId: normalizeText(requestTrace.userId || requestTrace.user_id),
    chatType: normalizeText(requestTrace.chatType),
    isAdmin: requestTrace.isAdmin === true
  };
}

function appendRequestTraceEvent(event = {}) {
  const payload = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const requestId = sanitizeTraceText(payload.requestId || payload.request_id).slice(0, 160);
  if (!requestId) return;
  const explicitSeq = Math.max(0, Number(payload.phaseSeq || payload.phase_seq || 0) || 0);
  if (explicitSeq > 0) {
    rememberRequestPhaseSeq(requestId, Math.max(Number(phaseSeqByRequestId.get(requestId) || 0) || 0, explicitSeq));
  }
  try {
    const logFile = resolveTraceLogFile();
    appendFileWithRotationBatched(logFile, `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      processId: process.pid,
      ...serializeRequestTraceEvent(payload),
      requestId
    })}\n`, {
      encoding: 'utf8'
    });
  } catch (_) {}
}

function flushRequestTraceEventsSync() {
  try {
    return flushBatchedLogWritesSync(resolveTraceLogFile());
  } catch (_) {
    return false;
  }
}

function resetRequestTraceStateForTests() {
  sequence = 0;
  phaseSeqByRequestId.clear();
}

function extractHttpStatus(error = null) {
  const direct = Number(error?.response?.status || error?.status || error?.statusCode || error?.status_code || 0);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const text = normalizeText(error?.message || error);
  const matched = text.match(/\b(?:http_error|status(?:_code)?|status)\D{0,12}(401|402|403|404|408|409|422|429|5\d\d)\b/i)
    || text.match(/\b(401|402|403|404|408|409|422|429|5\d\d)\b/);
  return matched ? Number(matched[1]) : 0;
}

function extractErrorCode(error = null) {
  const status = extractHttpStatus(error);
  if (status > 0) return `http_${status}`;
  const code = normalizeText(error?.code || error?.errorCode || error?.error_code);
  if (code) return code;
  const message = normalizeText(error?.message || error).toLowerCase();
  if (!message) return '';
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('network')) return 'network_error';
  return 'error';
}

function getTraceFromContainer(value = null) {
  if (!value || typeof value !== 'object') return null;
  return normalizeRequestTrace(value.requestTrace)
    || normalizeRequestTrace(value.trace)
    || normalizeRequestTrace(value.routeMeta?.requestTrace)
    || normalizeRequestTrace(value.routeMeta?.trace);
}

module.exports = {
  appendRequestTraceEvent,
  buildRequestId,
  cloneTraceForMeta,
  createRequestTrace,
  currentTraceFields,
  extractErrorCode,
  extractHttpStatus,
  getTraceFromContainer,
  nextTracePhase,
  normalizeRequestTrace,
  resetRequestTraceStateForTests,
  flushRequestTraceEventsSync
};
