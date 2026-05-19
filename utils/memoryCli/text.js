const { sanitizeText } = require('./commandParser');

function sanitizePreviewText(value, limit = 180) {
  const text = sanitizeText(value);
  if (!text) return '';
  const maxChars = Math.max(24, Number(limit) || 180);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3).trim()}...` : text;
}

function buildQueryTokens(query = '') {
  return sanitizeText(query).toLowerCase().split(/\s+/).filter(Boolean);
}

function scoreTextMatch(query = '', text = '') {
  const haystack = sanitizeText(text).toLowerCase();
  if (!haystack) return 0;
  const q = sanitizeText(query).toLowerCase();
  if (!q) return 0;
  if (haystack.includes(q)) return 1;
  const tokens = buildQueryTokens(q);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

module.exports = {
  buildQueryTokens,
  sanitizePreviewText,
  scoreTextMatch
};
