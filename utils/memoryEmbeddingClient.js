const crypto = require('crypto');
const config = require('../config');
const { postWithRetry } = require('../api/httpClient');

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  if (input.length === 0) return [];
  if (!options.force && !isEmbeddingConfigured()) return [];

  if (embedTexts.disabledUntil && Date.now() < embedTexts.disabledUntil && !options.force) {
    return [];
  }

  const model = String(options.model || getEmbeddingModel()).trim();
  const url = String(options.url || getEmbeddingApiBaseUrl()).trim();
  const key = String(options.apiKey || getEmbeddingApiKey()).trim();
  if (!model || !url || !key) return [];

  try {
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
    return parseEmbeddingResponse(response);
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
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
  hashText,
  embedTexts,
  embedText
};
