function stringifyBody(body = null) {
  if (typeof body === 'string') return body.trim();
  if (body === null || body === undefined) return '';
  try {
    return JSON.stringify(body);
  } catch (_) {
    return String(body || '').trim();
  }
}

function parseJsonTextSafe(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function extractUrlFromText(value = '') {
  const match = String(value || '').match(/(?:data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+|https?:\/\/[^\s"'`<>]+)/i);
  return String(match ? match[0] : '').trim();
}

function looksLikeHtmlDocument(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return text.startsWith('<!doctype html') || text.startsWith('<html') || text.includes('<head>') && text.includes('<body>');
}

function summarizePayloadShape(payload = null) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') {
    return payload.replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  try {
    const text = JSON.stringify(payload);
    return text.slice(0, 400);
  } catch (_) {
    return String(payload || '').trim().slice(0, 400);
  }
}

function normalizeRequestError(error = null) {
  const status = Number(error?.response?.status || 0) || 0;
  const body = stringifyBody(error?.response?.data);
  if (status > 0) {
    return `http_error status=${status} body=${body}`;
  }

  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || lower.includes('timeout') || lower.includes('timed out')) {
    return message || 'timeout';
  }
  if (
    code === 'ENOTFOUND'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'EAI_AGAIN'
  ) {
    return `network_error ${message}`.trim();
  }
  return message || 'unknown error';
}

module.exports = {
  extractUrlFromText,
  looksLikeHtmlDocument,
  normalizeRequestError,
  parseJsonTextSafe,
  stringifyBody,
  summarizePayloadShape
};
