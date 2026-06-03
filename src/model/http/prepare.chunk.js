const {
  HttpsProxyAgentCtor,
  CODEX_USER_AGENT,
  config,
  ensureAnthropicMessagesUrl,
  extractAnthropicCacheControl,
  getApiProvider,
  isAnthropicProvider,
  isGeminiNativeProvider,
  normalizeProviderRequestHeaders,
  normalizeText,
  providerAllowsCacheControl,
  providerAllowsOpenAIPromptCache,
  resolveSafeModelEndpoint,
  stripTopPField
} = require('./runtime-core.chunk');
const {
  buildChatCompletionsRequestBody,
  buildResponsesRequestBody,
  buildResponsesUrl,
  isResponsesUrl,
  preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache,
  requestBodyLooksLikeChatCompletion
} = require('./openai-compatible.chunk');
const {
  buildAnthropicRequestBody,
  buildRequestCacheTrace,
  extractProviderRequestHeaders,
  normalizeReasoningEffort,
  stripInternalRequestFields,
  stripProviderCacheFields
} = require('./request-shaping.chunk');
const { buildAnthropicRequestHeaders } = require('./runtime-core.chunk');
const { sanitizeOpenAICompatibleToolWithoutCache } = require('./images.chunk');
const {
  normalizeApiProvider
} = require('../../../utils/modelProvider');
const {
  buildGeminiNativeRequestBody,
  normalizeGeminiNativeApiBaseUrl
} = require('./gemini-native.chunk');

function shouldPreferResponsesProtocol(provider = '', url = '', requestBody = {}, originalBody = {}) {
  if (provider !== 'openai_compatible') return false;
  if (isResponsesUrl(url)) return true;
  if (originalBody?.__responsesProtocolFallbackAttempted === true) return false;
  const preferredProtocol = normalizeText(originalBody?.__preferredProtocol).toLowerCase().replace(/[-\s]+/g, '_');
  if (preferredProtocol === 'chat' || preferredProtocol === 'chat_completion' || preferredProtocol === 'chat_completions') return false;
  const responsesUrl = buildResponsesUrl(url);
  return isResponsesUrl(responsesUrl) && requestBodyLooksLikeChatCompletion(requestBody);
}

async function prepareRequest(url, body = {}) {
  const explicitProvider = normalizeText(body?.__provider || body?.__apiProvider);
  const provider = explicitProvider
    ? normalizeApiProvider(explicitProvider)
    : getApiProvider(url, body?.model || config.AI_MODEL, { preferUnifiedResponses: true });
  const internalRequestHeaders = extractProviderRequestHeaders(provider, body);
  if (!isAnthropicProvider(provider)) {
    const requestBody = body && typeof body === 'object'
      ? stripTopPField(stripProviderCacheFields(provider, stripInternalRequestFields({ ...body })))
      : body;
    if (isGeminiNativeProvider(provider)) {
      return {
        provider,
        requestUrl: normalizeGeminiNativeApiBaseUrl(url, body?.model || config.AI_MODEL),
        requestBody: await buildGeminiNativeRequestBody(requestBody),
        requestHeaders: internalRequestHeaders
      };
    }
    const shouldUseOpenAIPromptCache = Boolean(
      providerAllowsOpenAIPromptCache(provider)
      && requestBody
      && typeof requestBody === 'object'
      && (requestBody.prompt_cache_key || requestBody.prompt_cache_retention)
    );
    const shouldUseAnthropicCompatibleCache = Boolean(
      requestBody
      && typeof requestBody === 'object'
      && !shouldUseOpenAIPromptCache
      && providerAllowsCacheControl(provider)
    );
    const normalizedTopLevelCacheControl = extractAnthropicCacheControl(body);
    if (normalizedTopLevelCacheControl && shouldUseAnthropicCompatibleCache) {
      requestBody.cache_control = normalizedTopLevelCacheControl;
    }
    if (requestBody && Array.isArray(requestBody.messages)) {
      const shouldPreserveCacheControl = !shouldUseOpenAIPromptCache && providerAllowsCacheControl(provider);
      requestBody.messages = shouldUseOpenAIPromptCache
        ? await preprocessOpenAICompatibleMessagesWithoutCache(requestBody.messages)
        : (
            shouldPreserveCacheControl
              ? await preprocessOpenAICompatibleMessages(requestBody.messages)
              : await preprocessOpenAICompatibleMessagesWithoutCache(requestBody.messages)
          );
    }
    if (
      requestBody
      && (shouldUseOpenAIPromptCache || !providerAllowsCacheControl(provider))
      && Array.isArray(requestBody.tools)
    ) {
      requestBody.tools = requestBody.tools.map((tool) => sanitizeOpenAICompatibleToolWithoutCache(tool));
    }
    const reasoningEffort = normalizeReasoningEffort(requestBody?.reasoning_effort);
    if (requestBody && typeof requestBody === 'object') {
      if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;
      else delete requestBody.reasoning_effort;
    }
    const requestUrl = shouldPreferResponsesProtocol(provider, url, requestBody, body)
      ? buildResponsesUrl(url)
      : url;
    const finalRequestBody = isResponsesUrl(requestUrl)
      ? buildResponsesRequestBody(requestBody)
      : (
          /\/chat\/completions(?:\/)?$/i.test(String(requestUrl || '').trim()) && requestBodyLooksLikeChatCompletion(requestBody)
            ? buildChatCompletionsRequestBody(requestBody)
            : requestBody
        );
    return {
      provider,
      requestUrl,
      requestBody: finalRequestBody,
      requestHeaders: internalRequestHeaders
    };
  }

  const requestBody = await buildAnthropicRequestBody(stripInternalRequestFields(body));
  const anthropicRequestHeaders = buildAnthropicRequestHeaders(requestBody);
  return {
    provider,
    requestUrl: ensureAnthropicMessagesUrl(url),
    requestBody,
    requestHeaders: normalizeProviderRequestHeaders(provider, {
      ...(anthropicRequestHeaders || {}),
      ...(internalRequestHeaders || {})
    })
  };
}

/**
 * Build axios options used by all API requests.
 */
function getRequestTimeoutMs() {
  const n = Number(config.REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(n)) return 60000;
  return Math.max(10000, Math.floor(n));
}

function getStreamTimeoutMs() {
  const n = Number(config.REQUEST_STREAM_TIMEOUT_MS);
  const base = getRequestTimeoutMs();
  if (!Number.isFinite(n)) return Math.max(base, 120000);
  return Math.max(base, Math.floor(n));
}

function getFirstTokenTimeoutMs() {
  const n = Number(config.AI_STREAM_FIRST_TOKEN_TIMEOUT_MS);
  if (!Number.isFinite(n)) return 240000;
  return Math.max(10000, Math.floor(n));
}

function getRetryTimeoutMs(baseMs, attempt, stepMs, capMs) {
  const value = baseMs + (Math.max(0, attempt) * stepMs);
  return Math.min(capMs, value);
}

function containsAny(text, keywords = []) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return keywords.some((kw) => lower.includes(String(kw || '').toLowerCase()));
}

function isCloudflare403(err) {
  const status = Number(err?.response?.status);
  if (status !== 403) return false;

  const headers = err?.response?.headers || {};
  const server = String(headers.server || '');
  const cfRay = String(headers['cf-ray'] || '');
  const body = String(err?.response?.data || '');

  // Cloudflare blocked pages usually expose cf-ray header or cloudflare markers in body/html.
  if (containsAny(server, ['cloudflare'])) return true;
  if (cfRay.trim()) return true;
  if (containsAny(body, ['cloudflare', 'attention required', 'captcha', 'sorry, you have been blocked'])) return true;

  return false;
}

function parseRetryAfterMs(err) {
  const raw = err?.response?.headers?.['retry-after'];
  if (raw == null) return null;

  const text = String(raw).trim();
  if (!text) return null;

  const asSeconds = Number(text);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDate = Date.parse(text);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function getRetryDelayMs(err, attempt) {
  const retryAfterMs = parseRetryAfterMs(err);
  if (retryAfterMs != null) {
    const capped = Math.min(30000, Math.max(500, retryAfterMs));
    return capped + Math.floor(Math.random() * 250);
  }

  // Cloudflare challenge usually needs a longer cool-down than normal transient errors.
  if (isCloudflare403(err)) {
    const base = 2500 * Math.pow(2, attempt);
    const capped = Math.min(30000, base);
    return capped + Math.floor(Math.random() * 1000);
  }

  const base = 300 * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * 200);
}

function getHeaders(provider, specificKey = null, extraHeaders = null) {
  const apiKey = specificKey || config.API_KEY;
  const userAgent = String(
    config.MODEL_HTTP_USER_AGENT
      || config.MAIN_REPLY_USER_AGENT
      || config.HTTP_USER_AGENT
      || CODEX_USER_AGENT
  ).trim();
  const acceptLanguage = String(config.HTTP_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8').trim();
  if (isAnthropicProvider(provider)) {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': config.ANTHROPIC_VERSION || '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage
    };
    if (config.ANTHROPIC_BETA) {
      headers['anthropic-beta'] = String(config.ANTHROPIC_BETA).trim();
    }
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }
    const normalizedHeaders = normalizeProviderRequestHeaders(provider, headers) || {};
    normalizedHeaders['User-Agent'] = false;
    return normalizedHeaders;
  }

  if (isGeminiNativeProvider(provider)) {
    const headers = {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage
    };
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }
    const normalizedHeaders = normalizeProviderRequestHeaders(provider, headers) || {};
    normalizedHeaders['User-Agent'] = false;
    return normalizedHeaders;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': acceptLanguage,
    'User-Agent': userAgent
  };
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.assign(headers, extraHeaders);
  }
  return normalizeProviderRequestHeaders(provider, headers) || {};
}

function getAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null, abortSignal = null, lookup = null) {
  const options = {
    headers: getHeaders(provider, specificKey, extraHeaders),
    timeout: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getRequestTimeoutMs(),
    proxy: false,
    responseType: 'text'
  };
  if (abortSignal) options.signal = abortSignal;
  if (typeof lookup === 'function') options.lookup = lookup;

  if (config.PROXY_URL && HttpsProxyAgentCtor) {
    options.httpsAgent = new HttpsProxyAgentCtor(config.PROXY_URL);
  }
  return options;
}

function getStreamAxiosOptions(provider = 'openai_compatible', specificKey = null, timeoutMs = null, extraHeaders = null, abortSignal = null, lookup = null) {
  return {
    ...getAxiosOptions(
      provider,
      specificKey,
      Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : getStreamTimeoutMs(),
      extraHeaders,
      abortSignal,
      lookup
    ),
    responseType: 'stream'
  };
}

async function validatePreparedEndpoint(requestUrl) {
  return resolveSafeModelEndpoint(requestUrl, {
    allowLocalHttp: Boolean(config.MODEL_ENDPOINT_ALLOW_LOCAL_HTTP)
  });
}

function buildPinnedLookup(safeEndpoint = null) {
  const hostname = String(safeEndpoint?.hostname || '').trim().toLowerCase();
  const addresses = Array.isArray(safeEndpoint?.safeAddresses)
    ? safeEndpoint.safeAddresses.filter((entry) => entry?.address)
    : [];
  if (!hostname || addresses.length === 0) return null;

  return (lookupHost, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const requestedHost = String(lookupHost || '').trim().toLowerCase().replace(/\.+$/g, '');
    if (requestedHost !== hostname) {
      return require('dns').lookup(lookupHost, opts, cb);
    }

    const family = Number(opts?.family || 0);
    const matches = family === 4 || family === 6
      ? addresses.filter((entry) => Number(entry.family) === family)
      : addresses;
    const selected = matches[0] || addresses[0];
    if (opts && opts.all) {
      cb(null, matches.length ? matches : [selected]);
      return;
    }
    cb(null, selected.address, Number(selected.family) || 4);
  };
}

function shouldRetry(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  const status = Number(err?.response?.status);
  if (isCloudflare403(err)) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  // Network errors usually have no response object.
  if (!err?.response) return true;
  return false;
}

function shouldRetryStreamRequest(err, handlers = {}) {
  if (handlers && handlers.__abort_requested) return false;
  if (!shouldRetry(err)) return false;
  if (handlers && handlers.__stream_started) return false;
  return true;
}

module.exports = {
  buildRequestCacheTrace,
  containsAny,
  getAxiosOptions,
  getFirstTokenTimeoutMs,
  getHeaders,
  getRequestTimeoutMs,
  getRetryDelayMs,
  getRetryTimeoutMs,
  getStreamAxiosOptions,
  getStreamTimeoutMs,
  buildPinnedLookup,
  isCloudflare403,
  parseRetryAfterMs,
  prepareRequest,
  shouldRetry,
  shouldRetryStreamRequest,
  validatePreparedEndpoint
};
