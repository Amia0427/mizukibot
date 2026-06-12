const config = require('../../../config');

let cycleTlsFactory = null;
let cycleTlsClientPromise = null;
let cycleTlsUnavailableReason = '';
let warnedUnavailable = false;

function normalizeText(value) {
  return String(value || '').trim();
}

function isEnabled() {
  return config.MODEL_TLS_IMPERSONATION_ENABLED === true;
}

function isStreamEnabled() {
  return isEnabled() && config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED !== false;
}

function shouldFallbackToAxios() {
  return config.MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED !== false;
}

function isFallbackEnabled() {
  return shouldFallbackToAxios();
}

function getUserAgent(headers = {}) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || '').toLowerCase() === 'user-agent') return normalizeText(value);
  }
  return normalizeText(config.MODEL_HTTP_USER_AGENT || config.MAIN_REPLY_USER_AGENT || config.BROWSER_USER_AGENT);
}

function headersToPlainObject(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === false) continue;
    out[String(key)] = Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value);
  }
  return out;
}

function normalizeResponseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key || '').toLowerCase()] = value;
  }
  return out;
}

async function getCycleTLSClient() {
  if (!isEnabled()) return null;
  if (cycleTlsUnavailableReason) return null;
  if (!cycleTlsFactory) {
    try {
      cycleTlsFactory = require('cycletls');
    } catch (error) {
      cycleTlsUnavailableReason = error?.message || String(error);
      return null;
    }
  }
  if (!cycleTlsClientPromise) {
    cycleTlsClientPromise = Promise.resolve()
      .then(() => cycleTlsFactory())
      .catch((error) => {
        cycleTlsClientPromise = null;
        cycleTlsUnavailableReason = error?.message || String(error);
        return null;
      });
  }
  return cycleTlsClientPromise;
}

function buildCycleTlsOptions(body, axiosOptions = {}, stream = false) {
  const headers = headersToPlainObject(axiosOptions.headers);
  const timeoutMs = Math.max(1000, Number(axiosOptions.timeout) || Number(config.REQUEST_TIMEOUT_MS) || 60000);
  const options = {
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body || {}),
    headers,
    userAgent: getUserAgent(headers),
    timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    disableRedirect: true,
    responseType: stream ? 'stream' : 'text',
    enableConnectionReuse: config.MODEL_TLS_IMPERSONATION_CONNECTION_REUSE_ENABLED === true,
    insecureSkipVerify: config.MODEL_TLS_IMPERSONATION_INSECURE_SKIP_VERIFY === true,
    forceHTTP1: config.MODEL_TLS_IMPERSONATION_FORCE_HTTP1 === true
  };
  const proxy = normalizeText(config.PROXY_URL);
  if (proxy) options.proxy = proxy;
  const client = normalizeText(config.MODEL_TLS_IMPERSONATION_CLIENT).toLowerCase();
  if (client && client !== 'chrome') options.userAgent = getUserAgent(headers);
  const ja3 = normalizeText(config.MODEL_TLS_IMPERSONATION_JA3);
  const ja4r = normalizeText(config.MODEL_TLS_IMPERSONATION_JA4R);
  const h2 = normalizeText(config.MODEL_TLS_IMPERSONATION_HTTP2);
  if (ja3) options.ja3 = ja3;
  if (ja4r) options.ja4r = ja4r;
  if (h2 && !options.forceHTTP1) options.http2Fingerprint = h2;
  if (axiosOptions.signal) {
    axiosOptions.signal.addEventListener('abort', () => {
      options.__aborted = true;
    }, { once: true });
  }
  return options;
}

function createAxiosLikeResponse(cycleResponse, requestConfig = {}, stream = false) {
  const response = {
    status: Number(cycleResponse?.status || 0) || 0,
    statusText: '',
    headers: normalizeResponseHeaders(cycleResponse?.headers || {}),
    config: requestConfig,
    request: { transport: 'cycletls' },
    data: stream ? cycleResponse?.data : (
      typeof cycleResponse?.data === 'string'
        ? cycleResponse.data
        : String(cycleResponse?.data ?? '')
    )
  };
  Object.defineProperty(response, '__modelHttpTransport', {
    value: 'cycletls',
    enumerable: false,
    configurable: true
  });
  return response;
}

function createHttpError(response, url) {
  const error = new Error(`Request failed with status code ${response.status}`);
  error.name = 'AxiosError';
  error.code = response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  error.config = response.config;
  error.request = response.request;
  error.response = response;
  error.status = response.status;
  error.requestUrl = url;
  return error;
}

function createUnavailableError() {
  const error = new Error(`CycleTLS transport unavailable: ${cycleTlsUnavailableReason || 'unknown error'}`);
  error.code = 'MODEL_TLS_IMPERSONATION_UNAVAILABLE';
  return error;
}

function maybeWarnUnavailable() {
  if (warnedUnavailable || !cycleTlsUnavailableReason) return;
  warnedUnavailable = true;
  console.warn('[model-tls-impersonation] disabled for this process:', cycleTlsUnavailableReason);
}

async function postWithCycleTLS(url, body, axiosOptions = {}, { stream = false } = {}) {
  if (!isEnabled() || (stream && !isStreamEnabled())) return null;
  const client = await getCycleTLSClient();
  if (!client) {
    maybeWarnUnavailable();
    if (shouldFallbackToAxios()) return null;
    throw createUnavailableError();
  }
  const requestOptions = buildCycleTlsOptions(body, axiosOptions, stream);
  if (axiosOptions.signal?.aborted || requestOptions.__aborted) {
    const error = new Error('canceled');
    error.code = 'ERR_CANCELED';
    throw error;
  }
  const cycleResponse = await client(url, requestOptions, 'post');
  const response = createAxiosLikeResponse(cycleResponse, { url, method: 'post', ...axiosOptions }, stream);
  if (response.status < 200 || response.status >= 300) throw createHttpError(response, url);
  return response;
}

async function shutdownCycleTLS() {
  if (!cycleTlsClientPromise) return;
  const client = await cycleTlsClientPromise.catch(() => null);
  cycleTlsClientPromise = null;
  if (client && typeof client.exit === 'function') {
    await client.exit().catch(() => {});
  }
}

module.exports = {
  isFallbackEnabled,
  postWithCycleTLS,
  shutdownCycleTLS
};
