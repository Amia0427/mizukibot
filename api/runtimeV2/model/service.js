const config = require('../../../config');
const { postWithRetry, postStreamWithRetry } = require('../../httpClient');
const { extractMessageContent, extractSSEEvents, flushSSEState } = require('../../parser');
const { getToolSchemas } = require('../../toolRegistry');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { filterCompanionAllowedTools } = require('../../../utils/companionTools');
const { isToolSchemaValidationError } = require('../../../utils/modelCompat');
const {
  extractUserFacingDelta,
  hasVisibleUserFacingText,
  sanitizeUserFacingText
} = require('../../../utils/userFacingText');
const {
  buildReactiveRetryPayload,
  createContextCompactionHardBlockError,
  isContextOverflowError
} = require('../../../utils/contextCompaction');
const { isReplyFailure } = require('../../../utils/replyFailure');
const { runHumanizerAgent } = require('../../humanizerAgent');
const {
  buildMainModelRequest,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRetries,
  normalizeTextContent,
  withMainModelFallback
} = require('./shared');
const { shouldUsePlanModeForRequest } = require('../planning/service');
// source-compat anchors for role-aware main model routing:
// require('../../../utils/mainModelConfigResolver');
// function buildPrimaryMainModelConfig(overrides = null, userId = '') {
// const resolvedConfig = resolveUserScopedMainModelConfig(userId, modelConfig, options);
// const bypassFallback = shouldBypassMainModelFallback(userId, options);
const MODEL_RESPONSE_MALFORMED_REPLY = '刚才模型返回格式不稳定，我没拿到可用正文。你再发一次，我继续。';

function getAllowedToolNames(context = {}) {
  if (!Array.isArray(context.allowedTools)) return [];
  return filterCompanionAllowedTools(normalizeToolNames(context.allowedTools), config);
}

const filteredToolSchemaCache = new Map();

function getFilteredToolSchemas(context = {}) {
  const allowedNames = getAllowedToolNames(context);
  if (context.disableTools || allowedNames.length === 0) return [];
  const cacheKey = JSON.stringify({
    allowedTools: allowedNames,
    disableTools: Boolean(context.disableTools)
  });
  const cached = filteredToolSchemaCache.get(cacheKey);
  if (cached) {
    return cached.map((schema) => ({ ...schema, function: schema.function ? { ...schema.function } : schema.function }));
  }
  const allowedSet = new Set(allowedNames);
  const filtered = getToolSchemas().filter((schema) => {
    const toolName = String(schema?.function?.name || '').trim();
    return allowedSet.has(toolName);
  });
  filteredToolSchemaCache.set(cacheKey, filtered.map((schema) => ({
    ...schema,
    function: schema.function ? { ...schema.function } : schema.function
  })));
  return filtered.map((schema) => ({ ...schema, function: schema.function ? { ...schema.function } : schema.function }));
}

function finalizeStreamingReplyText(rawReply, fallbackText) {
  const text = sanitizeUserFacingText(normalizeTextContent(rawReply)).trim();
  return text || String(fallbackText || '').trim();
}

function buildReplyTextVariants(rawReply, fallbackText, options = {}) {
  const normalizedRaw = normalizeTextContent(rawReply);
  const visibleText = sanitizeUserFacingText(normalizedRaw, {
    preserveThink: options.preserveThink === true
  }).trim() || String(fallbackText || '').trim();
  const persistedText = sanitizeUserFacingText(normalizedRaw).trim() || String(fallbackText || '').trim();
  return {
    visibleText,
    persistedText
  };
}

function buildModelCallTrace(context = {}, source = 'v2_model') {
  return {
    source: String(context?.source || source).trim() || source,
    phase: String(context?.phase || '').trim(),
    purpose: String(context?.purpose || '').trim(),
    userId: String(context?.userId || context?.routeMeta?.userId || context?.routeMeta?.user_id || '').trim(),
    taskId: String(context?.taskId || '').trim(),
    routePolicyKey: String(context?.routePolicyKey || context?.routeMeta?.routePolicyKey || '').trim(),
    topRouteType: String(context?.topRouteType || context?.routeMeta?.topRouteType || '').trim(),
    memoryInjected: context?.memoryInjected
  };
}

function buildResolvedModelTrace(context = {}, resolvedConfig = null, source = 'v2_model') {
  const trace = buildModelCallTrace(context, source);
  const role = String(resolvedConfig?.__mainModelUserRole || '').trim();
  const warnings = Array.isArray(resolvedConfig?.__adminConfigWarnings)
    ? resolvedConfig.__adminConfigWarnings
    : [];
  return {
    ...trace,
    userRole: role,
    modelSource: String(resolvedConfig?.__mainModelSource || '').trim(),
    apiBaseUrlSource: String(resolvedConfig?.__mainApiBaseUrlSource || '').trim(),
    apiKeySource: String(resolvedConfig?.__mainApiKeySource || '').trim(),
    mainFallbackScope: String(resolvedConfig?.__mainFallbackScope || '').trim(),
    mainFallbackActive: resolvedConfig?.__mainFallbackActive === true,
    adminDedicatedModelConfigured: resolvedConfig?.__adminDedicatedModelConfigured,
    adminConfigWarnings: warnings
  };
}

function logResolvedModelCall(context = {}, resolvedConfig = null, source = 'v2_model') {
  const trace = buildResolvedModelTrace(context, resolvedConfig, source);
  const logPayload = {
    source: trace.source,
    userId: trace.userId,
    userRole: trace.userRole || 'user',
    routePolicyKey: trace.routePolicyKey,
    topRouteType: trace.topRouteType,
    model: getModelName(resolvedConfig),
    modelSource: trace.modelSource,
    apiBaseUrlSource: trace.apiBaseUrlSource,
    fallbackScope: trace.mainFallbackScope,
    fallbackActive: trace.mainFallbackActive,
    adminDedicatedModelConfigured: trace.adminDedicatedModelConfigured,
    adminConfigWarnings: trace.adminConfigWarnings
  };
  if (trace.userRole !== 'admin') {
    delete logPayload.adminDedicatedModelConfigured;
    delete logPayload.adminConfigWarnings;
  }
  console.log('[main-model] resolved call target', logPayload);
  return trace;
}

async function finalizeReplyText(rawReply, fallbackText, options = {}) {
  const variants = buildReplyTextVariants(rawReply, fallbackText, options);
  const base = variants.persistedText;
  if (!base) return { visibleText: '', persistedText: '' };
  if (isReplyFailure(base, { emptyIsFailure: true })) {
    return {
      visibleText: options.preserveThink === true ? variants.visibleText : base,
      persistedText: base
    };
  }
  if (typeof options.shouldBypassHumanizerForPolicy === 'function' && options.shouldBypassHumanizerForPolicy(options?.routePolicyKey)) {
    return {
      visibleText: options.preserveThink === true ? variants.visibleText : base,
      persistedText: base
    };
  }
  if (options.disableHumanizer) {
    return {
      visibleText: options.preserveThink === true ? variants.visibleText : base,
      persistedText: base
    };
  }
  const humanized = await runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig)
  });
  const persistedText = String(humanized || '').trim() || base;
  return {
    visibleText: options.preserveThink === true ? variants.visibleText : persistedText,
    persistedText
  };
}

async function requestAssistantMessage(messagesToSend, context = {}) {
  const modelConfig = context.modelConfig || null;
  const userId = String(context.userId || context.routeMeta?.userId || context.routeMeta?.user_id || '').trim();
  const toolSchemas = getFilteredToolSchemas(context);

  const requestOnce = async (resolvedConfig, includeTools = toolSchemas.length > 0, messages = messagesToSend) => {
    const callTrace = logResolvedModelCall(context, resolvedConfig, 'v2_assistant_message');
    const request = buildMainModelRequest(resolvedConfig, {
      messages,
      stream: false,
      defaultMaxTokens: 3500,
      trace: callTrace,
      routeMeta: context?.routeMeta,
      topRouteType: context?.topRouteType,
      tools: includeTools ? toolSchemas : []
    });
    const body = request.body;
    if (includeTools) {
      body.tools = toolSchemas;
      body.tool_choice = 'auto';
    }
    return postWithRetry(
      request.url,
      body,
      getRetries(1, resolvedConfig),
      getApiKey(resolvedConfig)
    );
  };

  const response = await withMainModelFallback(async (resolvedConfig) => {
    try {
      return await requestOnce(resolvedConfig, toolSchemas.length > 0);
    } catch (error) {
      if (toolSchemas.length > 0 && isToolSchemaValidationError(error)) {
        return requestOnce(resolvedConfig, false);
      }
      if (!isContextOverflowError(error)) throw error;
      const retryPayload = buildReactiveRetryPayload({
        messages: messagesToSend,
        canonicalSegments: context?.canonicalSegments,
        routeMeta: context?.routeMeta,
        source: String(context?.source || 'v2_assistant_message').trim() || 'v2_assistant_message',
        modelName: getModelName(resolvedConfig),
        modelWindowTokens: Number(
          context?.compactionPlan?.diagnostics?.modelWindowTokens
          || context?.modelWindowTokens
          || config.CONTEXT_WINDOW_MAX_TOKENS
          || 32000
        ) || 32000,
        maxOutputTokens: getMaxTokens(3500, resolvedConfig),
        preferRawTrim: !context?.canonicalSegments
      });
      try {
        return await requestOnce(resolvedConfig, false, retryPayload.messages);
      } catch (retryError) {
        if (isContextOverflowError(retryError)) {
          throw createContextCompactionHardBlockError(retryPayload.compactionPlan);
        }
        throw retryError;
      }
    }
  }, modelConfig, userId, { routeMeta: context?.routeMeta });

  const message = extractMessageContent(response);
  if (message) return message;

  console.error('AI response malformed(raw assistant):', String(response?.data).slice(0, 500));
  return {
    role: 'assistant',
    content: MODEL_RESPONSE_MALFORMED_REPLY
  };
}

async function requestNonStreamingReply(messagesToSend, context = {}) {
  const responseMessage = await requestAssistantMessage(messagesToSend, {
    ...context,
    disableTools: true,
    allowedTools: []
  });
  const reply = await finalizeReplyText(
    responseMessage?.content,
    MODEL_RESPONSE_MALFORMED_REPLY,
    {
      ...context,
      disableHumanizer: true
    }
  );
  return reply;
}

async function requestStreamingReply(messagesToSend, options = {}, modelConfig = null) {
  const parserState = { buffer: '' };
  let collected = '';
  const userId = String(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || '').trim();

  try {
    await withMainModelFallback(async (resolvedConfig) => {
      const requestStreamOnce = async (messages) => {
        const callTrace = logResolvedModelCall(options, resolvedConfig, 'v2_streaming_reply');
        const request = buildMainModelRequest(resolvedConfig, {
          messages,
          stream: true,
          defaultMaxTokens: 3500,
          trace: callTrace,
          routeMeta: options?.routeMeta,
          topRouteType: options?.topRouteType
        });
        await postStreamWithRetry(
          request.url,
          request.body,
          {
            onData(chunk) {
              const parsed = extractSSEEvents(parserState, chunk);
              parserState.buffer = parsed.state.buffer;
              for (const event of parsed.events) {
                if (!event || event.done || !event.delta) continue;
                const previousVisible = sanitizeUserFacingText(collected, {
                  preserveThink: options.preserveThink === true
                });
                collected += event.delta;
                const visibleCollected = sanitizeUserFacingText(collected, {
                  preserveThink: options.preserveThink === true
                });
                const visibleDelta = extractUserFacingDelta(previousVisible, visibleCollected);
                if (visibleCollected !== previousVisible) {
                  options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
                  if (typeof options.onDelta === 'function') {
                    options.onDelta(visibleDelta, visibleCollected);
                  }
                }
              }
            }
          },
          getRetries(1, resolvedConfig),
          getApiKey(resolvedConfig)
        );
      };

      try {
        await requestStreamOnce(messagesToSend);
      } catch (error) {
        if (!isContextOverflowError(error) || String(collected || '').trim()) throw error;
        const retryPayload = buildReactiveRetryPayload({
          messages: messagesToSend,
          canonicalSegments: options?.canonicalSegments,
          routeMeta: options?.routeMeta,
          source: String(options?.source || 'v2_streaming_reply').trim() || 'v2_streaming_reply',
          modelName: getModelName(resolvedConfig),
          modelWindowTokens: Number(
            options?.compactionPlan?.diagnostics?.modelWindowTokens
            || options?.modelWindowTokens
            || config.CONTEXT_WINDOW_MAX_TOKENS
            || 32000
          ) || 32000,
          maxOutputTokens: getMaxTokens(3500, resolvedConfig),
          preferRawTrim: !options?.canonicalSegments
        });
        try {
          await requestStreamOnce(retryPayload.messages);
        } catch (retryError) {
          if (isContextOverflowError(retryError) && !String(collected || '').trim()) {
            throw createContextCompactionHardBlockError(retryPayload.compactionPlan);
          }
          throw retryError;
        }
      }
    }, modelConfig, userId, { routeMeta: options?.routeMeta });
  } catch (error) {
    const visiblePartial = sanitizeUserFacingText(collected, {
      preserveThink: options.preserveThink === true
    }).trim();
    if (visiblePartial) {
      error.partialText = visiblePartial;
      error.streamHadOutput = true;
    }
    throw error;
  }

  const tailEvents = flushSSEState(parserState);
  for (const event of tailEvents) {
    if (!event || event.done || !event.delta) continue;
    const previousVisible = sanitizeUserFacingText(collected, {
      preserveThink: options.preserveThink === true
    });
    collected += event.delta;
    const visibleCollected = sanitizeUserFacingText(collected, {
      preserveThink: options.preserveThink === true
    });
    const visibleDelta = extractUserFacingDelta(previousVisible, visibleCollected);
    if (visibleCollected !== previousVisible) {
      options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
      if (typeof options.onDelta === 'function') {
        options.onDelta(visibleDelta, visibleCollected);
      }
    }
  }

  return buildReplyTextVariants(collected, '', options);
}

function finalizeStreamingReplyWithHumanizer(rawReply, fallbackText, options = {}) {
  const base = finalizeStreamingReplyText(rawReply, fallbackText);
  if (!base) return '';
  return runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig),
    stream: true,
    onDelta: options.onDelta,
    streamHadOutput: options.streamHadOutput,
    maxSegments: Number(config.AI_STREAM_MAX_SEGMENTS) || 3
  });
}

function shouldUseStreamingReply(question = '', customPrompt = null, imageUrl = null, options = {}) {
  if (!config.AI_STREAM_ENABLED) return false;
  if (config.HUMANIZER_FORCE_NON_STREAM) return false;
  if (typeof options.onDelta !== 'function') return false;
  if (options.disableStream) return false;
  if (options.modelConfig && typeof options.modelConfig === 'object') return false;
  if (imageUrl) return false;
  if (shouldUsePlanModeForRequest(question, {
    customPrompt,
    imageUrl,
    routePolicyKey: options?.routePolicyKey,
    topRouteType: options?.topRouteType
  })) return false;
  return true;
}

module.exports = {
  buildReplyTextVariants,
  finalizeReplyText,
  finalizeStreamingReplyText,
  finalizeStreamingReplyWithHumanizer,
  getAllowedToolNames,
  getFilteredToolSchemas,
  requestAssistantMessage,
  requestNonStreamingReply,
  requestStreamingReply,
  shouldUseStreamingReply,
  withMainModelFallback
};
