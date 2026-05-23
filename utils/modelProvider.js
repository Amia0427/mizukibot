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

function isGeminiNativeApiBase(url) {
  const normalized = normalizeApiBaseUrl(url).toLowerCase();
  if (!normalized) return false;

  return /\/models\/[^/?#]+:generatecontent(?:[?#].*)?$/i.test(normalized)
    || /:generatecontent(?:[?#].*)?$/i.test(normalized);
}

function getApiProvider(url, model = '', options = {}) {
  if (options && typeof options === 'object' && options.preferUnifiedResponses === true) {
    if (isAnthropicApiBase(url)) return 'anthropic';
    const normalized = normalizeApiBaseUrl(url).toLowerCase();
    if (/\/v1\/messages(?:\/)?$/i.test(normalized) && isClaudeModelName(model)) {
      return 'anthropic';
    }
    if (isGeminiNativeApiBase(url)) return 'gemini_native';
    return 'openai_compatible';
  }
  if (isAnthropicApiBase(url)) return 'anthropic';
  if (isGeminiNativeApiBase(url)) return 'gemini_native';

  // Some gateways expose Anthropic-style endpoints behind non-anthropic hosts.
  const normalized = normalizeApiBaseUrl(url).toLowerCase();
  if (/\/v1\/messages(?:\/)?$/i.test(normalized) && isClaudeModelName(model)) {
    return 'anthropic';
  }

  return 'openai_compatible';
}

function normalizeApiProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'gemini_native' || normalized === 'gemini' || normalized === 'google_gemini') return 'gemini_native';
  return 'openai_compatible';
}

function isOpenAICompatibleProvider(provider = '') {
  return normalizeApiProvider(provider) === 'openai_compatible';
}

function isAnthropicProvider(provider = '') {
  return normalizeApiProvider(provider) === 'anthropic';
}

function isGeminiNativeProvider(provider = '') {
  return normalizeApiProvider(provider) === 'gemini_native';
}

const PROVIDER_HEADER_ALLOWLISTS = {
  openai_compatible: new Map([
    ['authorization', 'Authorization'],
    ['content-type', 'Content-Type'],
    ['accept', 'Accept'],
    ['accept-language', 'Accept-Language'],
    ['user-agent', 'User-Agent'],
    ['openai-organization', 'OpenAI-Organization'],
    ['openai-project', 'OpenAI-Project'],
    ['http-referer', 'HTTP-Referer'],
    ['x-title', 'X-Title'],
    ['x-request-id', 'X-Request-Id']
  ]),
  anthropic: new Map([
    ['x-api-key', 'x-api-key'],
    ['anthropic-version', 'anthropic-version'],
    ['anthropic-beta', 'anthropic-beta'],
    ['content-type', 'Content-Type'],
    ['accept', 'Accept'],
    ['accept-language', 'Accept-Language']
  ]),
  gemini_native: new Map([
    ['x-goog-api-key', 'x-goog-api-key'],
    ['content-type', 'Content-Type'],
    ['accept', 'Accept'],
    ['accept-language', 'Accept-Language']
  ])
};

function normalizeProviderRequestHeaders(provider = 'openai_compatible', headers = null) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;

  const providerName = normalizeApiProvider(provider);
  const allowlist = PROVIDER_HEADER_ALLOWLISTS[providerName] || PROVIDER_HEADER_ALLOWLISTS.openai_compatible;
  const normalizedHeaders = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const lowerKey = String(rawKey || '').trim().toLowerCase();
    const value = String(rawValue || '').trim();
    if (!lowerKey || !value) continue;
    const canonicalKey = allowlist.get(lowerKey);
    if (!canonicalKey) continue;
    normalizedHeaders[canonicalKey] = value;
  }

  return Object.keys(normalizedHeaders).length > 0 ? normalizedHeaders : null;
}

function ensureAnthropicMessagesUrl(url) {
  const normalized = normalizeApiBaseUrl(url).replace(/\/+$/, '');
  if (!normalized) return normalized;

  if (/\/v1\/messages$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized.replace(/\/chat\/completions$/i, '/messages');
  }
  if (/\/responses$/i.test(normalized)) {
    return normalized.replace(/\/responses$/i, '/messages');
  }
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  return normalized;
}

module.exports = {
  normalizeApiBaseUrl,
  isClaudeModelName,
  isAnthropicApiBase,
  isGeminiNativeApiBase,
  getApiProvider,
  normalizeApiProvider,
  isOpenAICompatibleProvider,
  isAnthropicProvider,
  isGeminiNativeProvider,
  normalizeProviderRequestHeaders,
  ensureAnthropicMessagesUrl
};
