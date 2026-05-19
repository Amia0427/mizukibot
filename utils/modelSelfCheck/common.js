const config = require('../../config');

const CHECK_TYPES = Object.freeze([
  'plan',
  'embedding',
  'rerank',
  'memory',
  'main_reply',
  'admin_reply',
  'passive_awareness_decision',
  'passive_awareness_reply'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function clampTimeoutMs(value = config.MODEL_SELF_CHECK_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 12000;
  return Math.max(1000, Math.floor(n));
}

function createSkippedResult(type, model = '') {
  return {
    type,
    model: normalizeText(model),
    durationMs: null,
    status: 'skipped',
    timedOut: false
  };
}

function isTimeoutError(error = null) {
  const code = normalizeText(error?.code).toUpperCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

module.exports = {
  CHECK_TYPES,
  clampTimeoutMs,
  createSkippedResult,
  isTimeoutError,
  normalizeText
};
