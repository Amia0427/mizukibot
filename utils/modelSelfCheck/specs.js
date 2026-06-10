const {
  buildMainModelRequest,
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getModelName
} = require('../../api/runtimeV2/model/shared');
const { resolveUserScopedMainModelConfig } = require('../mainModelConfigResolver');
const {
  getEmbeddingApiBaseUrl,
  getEmbeddingApiKey,
  getEmbeddingModel,
  isEmbeddingConfigured
} = require('../memoryEmbeddingClient');
const {
  getRerankApiBaseUrl,
  getRerankApiKey,
  getRerankModel,
  isRerankConfigured
} = require('../memoryRerankClient');
const { clampTimeoutMs, normalizeText } = require('./common');
const {
  getMemoryApiKey,
  getMemoryCompletionsUrl,
  getMemoryModel,
  getPassiveAwarenessDecisionApiBaseUrl,
  getPassiveAwarenessDecisionApiKey,
  getPassiveAwarenessDecisionModel,
  getPassiveAwarenessReplyApiBaseUrl,
  getPassiveAwarenessReplyApiKey,
  getPassiveAwarenessReplyModel,
  getPassiveAwarenessReplyApiProvider,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  getPlannerModel,
  isPassiveAwarenessDecisionConfigured,
  isPassiveAwarenessReplyConfigured
} = require('./providers');
const { ensureEmbeddingsUrl, ensureRerankUrl } = require('./urls');

function buildChatBody(model, purpose, timeoutMs, options = {}) {
  const provider = normalizeText(options.provider);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Return ok.' },
      { role: 'user', content: 'ok' }
    ],
    max_tokens: 8,
    stream: false,
    __preferredProtocol: 'chat_completions',
    ...(provider ? { __provider: provider } : {}),
    __timeoutMs: timeoutMs,
    __trace: {
      source: 'model_self_check',
      purpose
    }
  };
}

function buildMainReplySpec(userId = '', type = 'main_reply', timeoutMs = clampTimeoutMs()) {
  const resolvedConfig = resolveUserScopedMainModelConfig(userId, null, {});
  const selfCheckConfig = {
    ...resolvedConfig,
    temperature: 0,
    maxTokens: 8,
    reasoningEffort: 'off',
    topA: NaN,
    topK: NaN,
    repetitionPenalty: NaN
  };
  const model = getModelName(selfCheckConfig);
  const apiBaseUrl = getApiBaseUrl(selfCheckConfig);
  const apiKey = getApiKey(selfCheckConfig);
  if (!apiBaseUrl || !apiKey || !model) {
    return {
      type,
      model,
      url: '',
      apiKey: '',
      body: null
    };
  }
  const request = buildMainModelRequest(selfCheckConfig, {
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
    body: (() => {
      const body = {
        ...request.body,
        max_tokens: Math.min(8, Number(request.body?.max_tokens || 8) || 8),
        stream: false,
        __timeoutMs: timeoutMs
      };
      delete body.prompt_cache_key;
      delete body.prompt_cache_retention;
      return body;
    })()
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
  const passiveReplyProvider = getPassiveAwarenessReplyApiProvider();

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
      url: getMemoryCompletionsUrl(ensureChatCompletionsUrl),
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
          body: buildChatBody(passiveReplyModel, 'passive_awareness_reply', timeoutMs, {
            provider: passiveReplyProvider
          })
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

module.exports = {
  buildChatBody,
  buildMainReplySpec,
  buildSelfCheckSpecs
};
