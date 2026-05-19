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

module.exports = {
  normalizeErrorCode,
  normalizeText,
  nowIso,
  safeClone
};
