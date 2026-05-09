const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { resolveUserScopedMainModelConfig } = require('./mainModelConfigResolver');
const {
  buildMainModelRequest,
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getModelName
} = require('../api/runtimeV2/model/shared');
const {
  getEmbeddingApiBaseUrl,
  getEmbeddingApiKey,
  getEmbeddingModel,
  isEmbeddingConfigured
} = require('./memoryEmbeddingClient');
const {
  getRerankApiBaseUrl,
  getRerankApiKey,
  getRerankModel,
  isRerankConfigured
} = require('./memoryRerankClient');

const CHECK_TYPES = Object.freeze([
  'plan',
  'embedding',
  'rerank',
  'memory',
  'main_reply',
  'admin_reply',
  'passive_awareness_decision',
  'passive_awareness_reply'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function clampTimeoutMs(value = config.MODEL_SELF_CHECK_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 12000;
  return Math.max(1000, Math.floor(n));
}

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

function getPlannerApiBaseUrl() {
  return normalizeText(
    config.PLAN_API_BASE_URL
    || process.env.PLANNER_API_BASE_URL
    || process.env.PLAN_API_BASEURI
    || process.env.PLANNER_API_BASEURI
    || config.AI_ROUTER_BASE_URL
    || config.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || config.PASSIVE_AWARENESS_API_BASE_URL
    || config.API_BASE_URL
  );
}

function getPlannerApiKey() {
  return normalizeText(
    config.PLAN_API_KEY
    || process.env.PLANNER_API_KEY
    || process.env.PLAN_APIKEY
    || process.env.PLANNER_APIKEY
    || config.AI_ROUTER_API_KEY
    || config.PASSIVE_AWARENESS_REPLY_API_KEY
    || config.PASSIVE_AWARENESS_API_KEY
    || config.API_KEY
  );
}

function getPlannerModel() {
  return normalizeText(config.PLAN_MODEL || config.AI_ROUTER_MODEL || config.AI_MODEL || 'gpt-5.4-mini') || 'gpt-5.4-mini';
}

function getMemoryCompletionsUrl() {
  return ensureChatCompletionsUrl(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '');
}

function getMemoryApiKey() {
  if (normalizeText(config.MEMORY_API_BASE_URL)) return normalizeText(config.MEMORY_API_KEY || config.API_KEY);
  return normalizeText(config.API_KEY);
}

function getMemoryModel() {
  return normalizeText(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

function getPassiveAwarenessDecisionModel() {
  return normalizeText(config.PASSIVE_AWARENESS_MODEL);
}

function getPassiveAwarenessDecisionApiBaseUrl() {
  return normalizeText(config.PASSIVE_AWARENESS_API_BASE_URL);
}

function getPassiveAwarenessDecisionApiKey() {
  return normalizeText(config.PASSIVE_AWARENESS_API_KEY);
}

function isPassiveAwarenessDecisionConfigured() {
  return Boolean(
    config.PASSIVE_AWARENESS_DECISION_ENABLED !== false
    && getPassiveAwarenessDecisionModel()
    && getPassiveAwarenessDecisionApiBaseUrl()
    && getPassiveAwarenessDecisionApiKey()
  );
}

function getPassiveAwarenessReplyModel() {
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL);
}

function getPassiveAwarenessReplyApiBaseUrl() {
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL);
}

function getPassiveAwarenessReplyApiKey() {
  return normalizeText(config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY);
}

function isPassiveAwarenessReplyConfigured() {
  return Boolean(
    getPassiveAwarenessReplyModel()
    && getPassiveAwarenessReplyApiBaseUrl()
    && getPassiveAwarenessReplyApiKey()
  );
}

function createSkippedResult(type, model = '') {
  return {
    type,
    model: normalizeText(model),
    durationMs: null,
    status: 'skipped',
    timedOut: false
  };
}

function isTimeoutError(error = null) {
  const code = normalizeText(error?.code).toUpperCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

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

function buildChatBody(model, purpose, timeoutMs) {
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Return ok.' },
      { role: 'user', content: 'ok' }
    ],
    max_tokens: 8,
    stream: false,
    __timeoutMs: timeoutMs,
    __trace: {
      source: 'model_self_check',
      purpose
    }
  };
}

function buildMainReplySpec(userId = '', type = 'main_reply', timeoutMs = clampTimeoutMs()) {
  const resolvedConfig = resolveUserScopedMainModelConfig(userId, null, {});
  const model = getModelName(resolvedConfig);
  const apiBaseUrl = getApiBaseUrl(resolvedConfig);
  const apiKey = getApiKey(resolvedConfig);
  if (!apiBaseUrl || !apiKey || !model) {
    return {
      type,
      model,
      url: '',
      apiKey: '',
      body: null
    };
  }
  const request = buildMainModelRequest(resolvedConfig, {
    messages: [
      { role: 'system', content: 'Return ok.' },
      { role: 'user', content: 'ok' }
    ],
    stream: false,
    defaultMaxTokens: 8,
    trace: {
      source: 'model_self_check',
      purpose: type,
      userId: normalizeText(userId)
    },
    topRouteType: type === 'admin_reply' ? 'admin' : 'direct_chat'
  });
  return {
    type,
    model,
    url: request.url,
    apiKey,
    body: {
      ...request.body,
      max_tokens: Math.min(8, Number(request.body?.max_tokens || 8) || 8),
      stream: false,
      __timeoutMs: timeoutMs
    }
  };
}

function buildSelfCheckSpecs(options = {}) {
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const adminUserId = normalizeText(options.adminUserId);
  const normalUserId = normalizeText(options.normalUserId) || '__model_self_check_user__';
  const planModel = getPlannerModel();
  const memoryModel = getMemoryModel();
  const embeddingModel = getEmbeddingModel();
  const rerankModel = getRerankModel();
  const passiveDecisionModel = getPassiveAwarenessDecisionModel();
  const passiveReplyModel = getPassiveAwarenessReplyModel();

  return [
    {
      type: 'plan',
      model: planModel,
      url: ensureChatCompletionsUrl(getPlannerApiBaseUrl()),
      apiKey: getPlannerApiKey(),
      body: buildChatBody(planModel, 'plan', timeoutMs)
    },
    isEmbeddingConfigured()
      ? {
          type: 'embedding',
          model: embeddingModel,
          url: ensureEmbeddingsUrl(getEmbeddingApiBaseUrl()),
          apiKey: getEmbeddingApiKey(),
          body: {
            model: embeddingModel,
            input: ['ok'],
            __timeoutMs: timeoutMs,
            __trace: {
              source: 'model_self_check',
              purpose: 'embedding'
            }
          }
        }
      : {
          type: 'embedding',
          model: embeddingModel,
          url: '',
          apiKey: '',
          body: null
        },
    isRerankConfigured()
      ? {
          type: 'rerank',
          model: rerankModel,
          url: ensureRerankUrl(getRerankApiBaseUrl()),
          apiKey: getRerankApiKey(),
          body: {
            model: rerankModel,
            query: 'ok',
            documents: ['ok', 'ping'],
            top_n: 1,
            __timeoutMs: timeoutMs,
            __trace: {
              source: 'model_self_check',
              purpose: 'rerank'
            }
          }
        }
      : {
          type: 'rerank',
          model: rerankModel,
          url: '',
          apiKey: '',
          body: null
        },
    {
      type: 'memory',
      model: memoryModel,
      url: getMemoryCompletionsUrl(),
      apiKey: getMemoryApiKey(),
      body: buildChatBody(memoryModel, 'memory', timeoutMs)
    },
    buildMainReplySpec(normalUserId, 'main_reply', timeoutMs),
    buildMainReplySpec(adminUserId, 'admin_reply', timeoutMs),
    isPassiveAwarenessDecisionConfigured()
      ? {
          type: 'passive_awareness_decision',
          model: passiveDecisionModel,
          url: ensureChatCompletionsUrl(getPassiveAwarenessDecisionApiBaseUrl()),
          apiKey: getPassiveAwarenessDecisionApiKey(),
          body: buildChatBody(passiveDecisionModel, 'passive_awareness_decision', timeoutMs)
        }
      : {
          type: 'passive_awareness_decision',
          model: passiveDecisionModel,
          url: '',
          apiKey: '',
          body: null
        },
    isPassiveAwarenessReplyConfigured()
      ? {
          type: 'passive_awareness_reply',
          model: passiveReplyModel,
          url: ensureChatCompletionsUrl(getPassiveAwarenessReplyApiBaseUrl()),
          apiKey: getPassiveAwarenessReplyApiKey(),
          body: buildChatBody(passiveReplyModel, 'passive_awareness_reply', timeoutMs)
        }
      : {
          type: 'passive_awareness_reply',
          model: passiveReplyModel,
          url: '',
          apiKey: '',
          body: null
        }
  ];
}

async function runModelSelfCheck(options = {}) {
  const specs = buildSelfCheckSpecs(options);
  const results = await Promise.all(specs.map((spec) => runCheckRequest(spec, options)));
  const byType = new Map(results.map((result) => [result.type, result]));
  return CHECK_TYPES.map((type) => byType.get(type) || createSkippedResult(type));
}

function formatModelSelfCheckReport(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const lines = ['模型自检:'];
  for (const row of rows) {
    const type = normalizeText(row?.type) || 'unknown';
    const model = normalizeText(row?.model) || '-';
    const status = normalizeText(row?.status) || 'failed';
    const timeout = row?.timedOut === true ? 'true' : 'false';
    const duration = Number.isFinite(Number(row?.durationMs))
      ? `${Math.max(0, Math.floor(Number(row.durationMs)))}ms`
      : 'skipped';
    lines.push(`${type} | ${model} | ${duration} | ${status} | timeout=${timeout}`);
  }
  return lines.join('\n');
}

module.exports = {
  CHECK_TYPES,
  buildSelfCheckSpecs,
  clampTimeoutMs,
  formatModelSelfCheckReport,
  isTimeoutError,
  runCheckRequest,
  runModelSelfCheck
};
