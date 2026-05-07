const crypto = require('crypto');
const config = require('../config');

let lastEmbeddingFailure = {
  reason: '',
  status: 0,
  message: '',
  at: 0
};

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getPostWithRetry() {
  try {
    return require('../api/httpClient').postWithRetry;
  } catch (_) {
    return null;
  }
}

function trimTrailingSlash(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getEmbeddingApiBaseUrl() {
  const raw = trimTrailingSlash(config.MEMORY_EMBEDDING_API_BASE_URL || config.MEMORY_API_BASE_URL || config.API_BASE_URL || '');
  if (!raw) return '';
  if (/\/embeddings$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/embeddings`;
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/embeddings');
  return `${raw}/embeddings`;
}

function getEmbeddingApiKey() {
  return String(config.MEMORY_EMBEDDING_API_KEY || config.MEMORY_API_KEY || config.API_KEY || '').trim();
}

function getEmbeddingModel() {
  return String(config.MEMORY_EMBEDDING_MODEL || '').trim();
}

function isEmbeddingConfigured() {
  return Boolean(
    config.MEMORY_EMBEDDING_ENABLED
    && getEmbeddingModel()
    && getEmbeddingApiBaseUrl()
    && getEmbeddingApiKey()
  );
}

function normalizeEmbeddingVector(value) {
  if (!Array.isArray(value)) return null;
  const vector = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (vector.length !== value.length || vector.length === 0) return null;
  return vector;
}

function cosineArray(a = [], b = []) {
  const left = normalizeEmbeddingVector(a);
  const right = normalizeEmbeddingVector(b);
  const length = Math.min(left ? left.length : 0, right ? right.length : 0);
  if (length === 0) return 0;

  let dotSum = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const va = left[i];
    const vb = right[i];
    dotSum += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dotSum / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseEmbeddingResponse(response) {
  const payload = response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response;
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((row) => normalizeEmbeddingVector(row?.embedding)).filter(Boolean);
}

function classifyEmbeddingFailure(error = null, fallbackReason = 'embedding_request_failed') {
  if (!error) return fallbackReason || 'empty_embedding';
  const status = Number(error?.response?.status || error?.status || 0) || 0;
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 408 || status === 504 || code.includes('timeout') || code === 'etimedout' || code === 'econnaborted' || message.includes('timeout')) {
    return 'timeout';
  }
  if (fallbackReason) return fallbackReason;
  return 'embedding_request_failed';
}

function setLastEmbeddingFailure(reason = 'embedding_request_failed', details = {}) {
  lastEmbeddingFailure = {
    reason: sanitizeText(reason) || 'embedding_request_failed',
    status: Number(details.status || 0) || 0,
    message: sanitizeText(details.message || ''),
    at: Date.now()
  };
  return lastEmbeddingFailure;
}

function clearLastEmbeddingFailure() {
  lastEmbeddingFailure = {
    reason: '',
    status: 0,
    message: '',
    at: 0
  };
}

function getLastEmbeddingFailure() {
  return { ...lastEmbeddingFailure };
}

function hashText(text = '') {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function clampInputText(text = '') {
  const maxChars = Math.max(64, Number(config.MEMORY_EMBEDDING_MAX_TEXT_CHARS) || 1200);
  return sanitizeText(text).slice(0, maxChars);
}

async function embedTexts(texts = [], options = {}) {
  const input = (Array.isArray(texts) ? texts : [texts])
    .map((text) => clampInputText(text))
    .filter(Boolean);
  if (input.length === 0) {
    setLastEmbeddingFailure('empty_embedding', { message: 'empty_input' });
    return [];
  }
  if (!options.force && !isEmbeddingConfigured()) {
    setLastEmbeddingFailure('embedding_request_failed', { message: 'embedding_not_configured' });
    return [];
  }

  if (embedTexts.disabledUntil && Date.now() < embedTexts.disabledUntil && !options.force) {
    setLastEmbeddingFailure('embedding_request_failed', { message: 'embedding_temporarily_disabled' });
    return [];
  }

  const model = String(options.model || getEmbeddingModel()).trim();
  const url = String(options.url || getEmbeddingApiBaseUrl()).trim();
  const key = String(options.apiKey || getEmbeddingApiKey()).trim();
  if (!model || !url || !key) {
    setLastEmbeddingFailure('embedding_request_failed', { message: 'missing_embedding_config' });
    return [];
  }

  try {
    const postWithRetry = getPostWithRetry();
    if (typeof postWithRetry !== 'function') {
      setLastEmbeddingFailure('embedding_request_failed', { message: 'post_with_retry_unavailable' });
      return [];
    }
    const response = await postWithRetry(
      url,
      {
        model,
        input,
        __timeoutMs: Math.max(1000, Number(options.timeoutMs || config.MEMORY_EMBEDDING_TIMEOUT_MS) || 12000),
        __trace: {
          source: 'memoryEmbeddingClient',
          purpose: 'memory_embedding'
        }
      },
      0,
      key
    );
    embedTexts.disabledUntil = 0;
    const vectors = parseEmbeddingResponse(response);
    if (vectors.length === 0) {
      setLastEmbeddingFailure('empty_embedding', { message: 'empty_embedding_response' });
      return [];
    }
    clearLastEmbeddingFailure();
    return vectors;
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
    const reason = classifyEmbeddingFailure(error, 'embedding_request_failed');
    setLastEmbeddingFailure(reason, {
      status,
      message: error.message
    });
    if (status === 400 || status === 404) {
      embedTexts.disabledUntil = Date.now() + (30 * 60 * 1000);
      console.warn('[memoryEmbeddingClient] embedding endpoint unavailable, falling back for 30 minutes');
    } else {
      console.error('[memoryEmbeddingClient] embedding request failed:', error.message);
    }
    return [];
  }
}

async function embedText(text = '', options = {}) {
  const vectors = await embedTexts([text], options);
  return vectors[0] || null;
}

module.exports = {
  getEmbeddingApiBaseUrl,
  getEmbeddingApiKey,
  getEmbeddingModel,
  isEmbeddingConfigured,
  normalizeEmbeddingVector,
  cosineArray,
  parseEmbeddingResponse,
  classifyEmbeddingFailure,
  getLastEmbeddingFailure,
  hashText,
  embedTexts,
  embedText
};
