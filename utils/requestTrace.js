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

function normalizeText(value) {
  return String(value || '').trim();
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
  const requestId = normalizeText(payload.requestId || payload.request_id);
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
      ...payload,
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
