const { normalizeText } = require('./common');

function ensureEmbeddingsUrl(url = '') {
  const normalized = normalizeText(url).replace(/\/+$/, '');
  if (!normalized) return '';
  if (/\/embeddings$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, '/embeddings');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/embeddings`;
  return `${normalized}/embeddings`;
}

function ensureRerankUrl(url = '') {
  const normalized = normalizeText(url).replace(/\/+$/, '');
  if (!normalized) return '';
  if (/\/rerank$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, '/rerank');
  if (/\/embeddings$/i.test(normalized)) return normalized.replace(/\/embeddings$/i, '/rerank');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/rerank`;
  return `${normalized}/rerank`;
}

module.exports = {
  ensureEmbeddingsUrl,
  ensureRerankUrl
};
