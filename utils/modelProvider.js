function normalizeApiBaseUrl(url) {
  return String(url || '').trim();
}

function isClaudeModelName(model) {
  return /^claude/i.test(String(model || '').trim());
}

function isAnthropicApiBase(url) {
  const normalized = normalizeApiBaseUrl(url).toLowerCase();
  if (!normalized) return false;

  if (normalized.includes('anthropic.com')) return true;
  if (/\/v1\/messages(?:\/)?$/i.test(normalized)) return true;
  if (/\/anthropic\/v1\/messages(?:\/)?$/i.test(normalized)) return true;
  return false;
}

function getApiProvider(url, model = '') {
  if (isAnthropicApiBase(url)) return 'anthropic';

  // Some gateways expose Anthropic-style endpoints behind non-anthropic hosts.
  const normalized = normalizeApiBaseUrl(url).toLowerCase();
  if (/\/v1\/messages(?:\/)?$/i.test(normalized) && isClaudeModelName(model)) {
    return 'anthropic';
  }

  return 'openai_compatible';
}

function ensureAnthropicMessagesUrl(url) {
  const normalized = normalizeApiBaseUrl(url).replace(/\/+$/, '');
  if (!normalized) return normalized;

  if (/\/v1\/messages$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized.replace(/\/chat\/completions$/i, '/messages');
  }
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  return normalized;
}

module.exports = {
  normalizeApiBaseUrl,
  isClaudeModelName,
  isAnthropicApiBase,
  getApiProvider,
  ensureAnthropicMessagesUrl
};
