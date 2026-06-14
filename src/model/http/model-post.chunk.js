const {
  axios,
  config
} = require('./runtime-core.chunk');
const {
  isFallbackEnabled,
  postWithCycleTLS
} = require('./cycle-tls-transport.chunk');

let warnedCycleTlsFallback = false;

function isCycleTlsMisdirectedRequest(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  if (status !== 421) return false;
  const transport = String(
    error?.request?.transport
    || error?.response?.request?.transport
    || error?.response?.__modelHttpTransport
    || ''
  ).toLowerCase();
  return transport === 'cycletls';
}

function shouldFallbackToAxios(error) {
  if (!isFallbackEnabled()) return false;
  if (error?.response) return isCycleTlsMisdirectedRequest(error);
  return true;
}

function maybeWarnFallback(error) {
  if (warnedCycleTlsFallback) return;
  warnedCycleTlsFallback = true;
  console.warn('[model-tls-impersonation] falling back to axios:', error?.message || error);
}

async function postModelHttp(url, body, axiosOptions = {}) {
  const useStream = axiosOptions && axiosOptions.responseType === 'stream';
  let cycleResponse = null;
  try {
    cycleResponse = await postWithCycleTLS(url, body, axiosOptions, { stream: useStream });
  } catch (error) {
    if (!shouldFallbackToAxios(error)) throw error;
    maybeWarnFallback(error);
  }
  if (cycleResponse) return cycleResponse;
  const response = await axios.post(url, body, axiosOptions);
  Object.defineProperty(response, '__modelHttpTransport', {
    value: 'axios',
    enumerable: false,
    configurable: true
  });
  return response;
}

function getModelHttpTransportStatus() {
  return {
    tlsImpersonationEnabled: config.MODEL_TLS_IMPERSONATION_ENABLED === true,
    tlsImpersonationStreamEnabled: config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED === true,
    tlsImpersonationFallbackEnabled: config.MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED !== false,
    tlsImpersonationClient: String(config.MODEL_TLS_IMPERSONATION_CLIENT || '').trim() || 'chrome'
  };
}

module.exports = {
  getModelHttpTransportStatus,
  isCycleTlsMisdirectedRequest,
  postModelHttp
};
