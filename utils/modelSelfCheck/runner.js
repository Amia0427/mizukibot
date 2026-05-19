const { postWithRetry } = require('../../api/httpClient');
const {
  clampTimeoutMs,
  createSkippedResult,
  isTimeoutError,
  normalizeText
} = require('./common');

async function runCheckRequest(spec = {}, options = {}) {
  const type = normalizeText(spec.type);
  const model = normalizeText(spec.model);
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  if (!type) {
    return createSkippedResult('unknown', model);
  }
  if (!normalizeText(spec.url) || !normalizeText(spec.apiKey) || !model) {
    return createSkippedResult(type, model);
  }

  const startedAt = Date.now();
  try {
    await postWithRetry(
      spec.url,
      {
        ...(spec.body && typeof spec.body === 'object' ? spec.body : {}),
        __timeoutMs: timeoutMs
      },
      0,
      spec.apiKey
    );
    return {
      type,
      model,
      durationMs: Math.max(0, Date.now() - startedAt),
      status: 'ok',
      timedOut: false
    };
  } catch (error) {
    const timedOut = isTimeoutError(error);
    return {
      type,
      model,
      durationMs: Math.max(0, Date.now() - startedAt),
      status: timedOut ? 'timeout' : 'failed',
      timedOut
    };
  }
}

module.exports = {
  runCheckRequest
};
