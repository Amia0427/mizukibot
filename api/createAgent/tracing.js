const {
  appendRequestTraceEvent,
  nextTracePhase,
  normalizeRequestTrace
} = require('../../utils/requestTrace');
const {
  buildCreateAgentChatCompletionsUrl,
  buildCreateAgentGenerationUrl
} = require('./config');
const { appendTextFileSafe } = require('./fileState');
const { summarizePayloadShape } = require('./requestUtils');
const { normalizePromptText } = require('./promptBuilder');

function getCreateAgentRequestTrace(deps = {}, context = {}) {
  return normalizeRequestTrace(deps.requestTrace)
    || normalizeRequestTrace(context.requestTrace)
    || normalizeRequestTrace(context.routeMeta?.requestTrace);
}

function emitCreateAgentTrace(trace = null, stage = '', payload = {}) {
  const requestTrace = normalizeRequestTrace(trace);
  if (!requestTrace) return;
  appendRequestTraceEvent(nextTracePhase(requestTrace, stage || 'create_agent', {
    tracePhase: stage || 'create_agent',
    stage: stage || 'create_agent',
    source: 'createAgentExecutor',
    ...payload
  }));
}

function buildCreateAgentTracePayload(runtimeConfig = {}, requestUrl = '', extra = {}) {
  return {
    provider: 'openai_compatible',
    model: String(runtimeConfig.model || '').trim(),
    requestUrl: String(requestUrl || '').trim(),
    protocol: String(runtimeConfig.protocol || 'images').trim(),
    cache: null,
    fallbackActive: false,
    ...extra
  };
}

function logCreateAgentError(runtimeConfig = {}, context = {}, error = null) {
  const fallbackRequestUrl = runtimeConfig.protocol === 'chat_completions'
    ? buildCreateAgentChatCompletionsUrl(runtimeConfig.apiBaseUrl)
    : buildCreateAgentGenerationUrl(runtimeConfig.apiBaseUrl);
  const napcatRetcode = Number.isFinite(Number(error?.retcode)) ? Number(error.retcode) : null;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    prompt: normalizePromptText(context.prompt || context.payload || '').slice(0, 500),
    groupId: String(context.groupId || '').trim(),
    senderId: String(context.senderId || '').trim(),
    model: String(runtimeConfig.model || '').trim(),
    apiBaseUrl: String(runtimeConfig.apiBaseUrl || '').trim(),
    protocol: String(runtimeConfig.protocol || 'images').trim(),
    requestedImageSize: String(runtimeConfig.requestedImageSize || '').trim(),
    effectiveImageSize: String(runtimeConfig.imageSize || '').trim(),
    requestUrl: String(context.requestUrl || fallbackRequestUrl).trim(),
    backend: runtimeConfig.protocol === 'chat_completions' ? 'openai_chat_completions' : 'openai_images',
    responsePreview: String(context.responsePreview || '').trim(),
    error: String(error?.message || error || '').trim(),
    errorName: String(error?.name || '').trim(),
    errorCode: String(error?.code || '').trim(),
    napcatAction: String(error?.action || '').trim(),
    napcatStatus: String(error?.status || '').trim(),
    napcatRetcode,
    napcatData: error?.data === undefined ? '' : summarizePayloadShape(error.data)
  });
  appendTextFileSafe(runtimeConfig.errorLogFile, `${line}\n`);
}

module.exports = {
  getCreateAgentRequestTrace,
  emitCreateAgentTrace,
  buildCreateAgentTracePayload,
  logCreateAgentError
};
