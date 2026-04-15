const config = require('../../../config');
const { postWithRetry, postStreamWithRetry } = require('../../httpClient');
const { extractMessageContent, extractSSEEvents, flushSSEState } = require('../../parser');
const { getToolSchemas } = require('../../toolRegistry');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
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
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRetries,
  getTemperature,
  getTopP,
  normalizeTextContent,
  withMainModelFallback
} = require('./shared');
const { shouldUsePlanModeForRequest } = require('../planning/service');
// source-compat anchors for role-aware main model routing:
// require('../../../utils/mainModelConfigResolver');
// function buildPrimaryMainModelConfig(overrides = null, userId = '') {
// const resolvedConfig = resolveUserScopedMainModelConfig(userId, modelConfig, options);
// const bypassFallback = shouldBypassMainModelFallback(userId, options);

function getAllowedToolNames(context = {}) {
  if (!Array.isArray(context.allowedTools)) return [];
  return normalizeToolNames(context.allowedTools);
}

function getFilteredToolSchemas(context = {}) {
  const allowedNames = getAllowedToolNames(context);
  if (context.disableTools || allowedNames.length === 0) return [];
  const allowedSet = new Set(allowedNames);
  return getToolSchemas().filter((schema) => {
    const toolName = String(schema?.function?.name || '').trim();
    return allowedSet.has(toolName);
  });
}

function finalizeStreamingReplyText(rawReply, fallbackText) {
  const text = sanitizeUserFacingText(normalizeTextContent(rawReply)).trim();
  return text || String(fallbackText || '').trim();
}

async function finalizeReplyText(rawReply, fallbackText, options = {}) {
  const base = finalizeStreamingReplyText(rawReply, fallbackText);
  if (!base) return '';
  if (isReplyFailure(base, { emptyIsFailure: true })) return base;
  if (typeof options.shouldBypassHumanizerForPolicy === 'function' && options.shouldBypassHumanizerForPolicy(options?.routePolicyKey)) {
    return base;
  }
  if (options.disableHumanizer) return base;
  return runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig)
  });
}

async function requestAssistantMessage(messagesToSend, context = {}) {
  const modelConfig = context.modelConfig || null;
  const userId = String(context.userId || context.routeMeta?.userId || context.routeMeta?.user_id || '').trim();
  const toolSchemas = getFilteredToolSchemas(context);

  const requestOnce = async (resolvedConfig, includeTools = toolSchemas.length > 0, messages = messagesToSend) => {
    const body = {
      model: getModelName(resolvedConfig),
      temperature: getTemperature(resolvedConfig),
      top_p: getTopP(resolvedConfig),
      messages,
      max_tokens: getMaxTokens(3500, resolvedConfig),
      stream: false
    };
    if (includeTools) {
      body.tools = toolSchemas;
      body.tool_choice = 'auto';
    }
    return postWithRetry(
      ensureChatCompletionsUrl(getApiBaseUrl(resolvedConfig)),
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
    content: 'The model response format was malformed. Please try again.'
  };
}

async function requestNonStreamingReply(messagesToSend, context = {}) {
  const responseMessage = await requestAssistantMessage(messagesToSend, {
    ...context,
    disableTools: true,
    allowedTools: []
  });
  return finalizeReplyText(
    responseMessage?.content,
    'The model response format was malformed. Please try again.',
    {
      ...context,
      disableHumanizer: true
    }
  );
}

async function requestStreamingReply(messagesToSend, options = {}, modelConfig = null) {
  const parserState = { buffer: '' };
  let collected = '';
  const userId = String(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || '').trim();

  try {
    await withMainModelFallback(async (resolvedConfig) => {
      const mainUrl = ensureChatCompletionsUrl(getApiBaseUrl(resolvedConfig));
      const requestStreamOnce = async (messages) => {
        await postStreamWithRetry(
          mainUrl,
          {
            model: getModelName(resolvedConfig),
            temperature: getTemperature(resolvedConfig),
            top_p: getTopP(resolvedConfig),
            messages,
            max_tokens: getMaxTokens(3500, resolvedConfig),
            stream: true
          },
          {
            onData(chunk) {
              const parsed = extractSSEEvents(parserState, chunk);
              parserState.buffer = parsed.state.buffer;
              for (const event of parsed.events) {
                if (!event || event.done || !event.delta) continue;
                const previousVisible = sanitizeUserFacingText(collected);
                collected += event.delta;
                const visibleCollected = sanitizeUserFacingText(collected);
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
    const visiblePartial = sanitizeUserFacingText(collected).trim();
    if (visiblePartial) {
      error.partialText = visiblePartial;
      error.streamHadOutput = true;
    }
    throw error;
  }

  const tailEvents = flushSSEState(parserState);
  for (const event of tailEvents) {
    if (!event || event.done || !event.delta) continue;
    const previousVisible = sanitizeUserFacingText(collected);
    collected += event.delta;
    const visibleCollected = sanitizeUserFacingText(collected);
    const visibleDelta = extractUserFacingDelta(previousVisible, visibleCollected);
    if (visibleCollected !== previousVisible) {
      options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
      if (typeof options.onDelta === 'function') {
        options.onDelta(visibleDelta, visibleCollected);
      }
    }
  }

  return sanitizeUserFacingText(collected);
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
