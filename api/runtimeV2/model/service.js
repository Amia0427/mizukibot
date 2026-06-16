const config = require('../../../config');
const { postWithRetry, postStreamWithRetry } = require('../../httpClient');
const { extractMessageContent, extractSSEEvents, flushSSEState, parseJsonWithSafety } = require('../../parser');
const { recordModelCallParseFailure } = require('../../../utils/modelCallTracker');
const { getToolSchemaByName } = require('../../toolRegistry');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { filterCompanionAllowedTools } = require('../../../utils/companionTools');
const { isAdminPrivateChatContext } = require('../../../utils/privilegedPrivateChat');
const {
  WEB_LOOKUP_ALLOWED_TOOLS,
  routeHasExplicitWebSearchRequirement
} = require('../../../utils/webSearchRequirement');
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
  createNormalUserMainReplyStreamFirstTokenTimeoutError
} = require('../../../utils/normalUserMainReplyStreamTimeout');
const {
  createAdminPrivateMainReplyStreamFirstTokenTimeoutError
} = require('../../../utils/adminPrivateMainReplyStreamTimeout');
const {
  buildMainModelRequest,
  getApiBaseUrl,
  getApiKey,
  getMainReplyDefaultMaxTokens,
  getMaxTokens,
  getModelName,
  getRetries,
  resolveMainProvider,
  normalizeTextContent,
  withMainModelFallback
} = require('./shared');
const { shouldUsePlanModeForRequest } = require('../planning/service');
const { normalizeRequestTrace } = require('../../../utils/requestTrace');
const {
  buildModelRouteDiagnostics,
  createModelRouteTracePatch
} = require('../../../utils/modelRouteDiagnostics');
// source-compat anchors for role-aware main model routing:
// require('../../../utils/mainModelConfigResolver');
// function buildPrimaryMainModelConfig(overrides = null, userId = '') {
// const resolvedConfig = resolveUserScopedMainModelConfig(userId, modelConfig, options);
// const bypassFallback = shouldBypassMainModelFallback(userId, options);
const MODEL_RESPONSE_MALFORMED_REPLY = '刚才模型返回格式不稳定，我没拿到可用正文。你再发一次，我继续。';
const FILTERED_TOOL_SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000;
const FILTERED_TOOL_SCHEMA_CACHE_MAX_ENTRIES = 100;
const MALFORMED_RESPONSE_LOG_PREVIEW_CHARS = 240;

function listObjectKeys(value, limit = 12) {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).slice(0, limit);
}

function summarizeMalformedResponse(response = null) {
  const data = response?.data;
  let parsed = data;
  let stringJsonParsed = false;
  let jsonParseGuard = '';
  if (typeof data === 'string') {
    const parseResult = parseJsonWithSafety(data);
    if (parseResult.ok) {
      parsed = parseResult.value;
      stringJsonParsed = true;
    } else {
      jsonParseGuard = parseResult.reason || 'parse_error';
    }
  }
  const firstChoice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const firstCandidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : null;
  const firstOutput = Array.isArray(parsed?.output) ? parsed.output[0] : null;
  const geminiParts = Array.isArray(firstCandidate?.content?.parts)
    ? firstCandidate.content.parts
    : [];
  return {
    response_data_type: Array.isArray(data) ? 'array' : typeof data,
    parsed_type: Array.isArray(parsed) ? 'array' : typeof parsed,
    string_json_parsed: stringJsonParsed,
    string_json_parse_guard: jsonParseGuard,
    status_code: Number(response?.status || 0) || null,
    top_level_keys: listObjectKeys(parsed),
    choices_count: Array.isArray(parsed?.choices) ? parsed.choices.length : null,
    first_choice_keys: listObjectKeys(firstChoice),
    first_choice_finish_reason: String(firstChoice?.finish_reason || '').trim(),
    candidates_count: Array.isArray(parsed?.candidates) ? parsed.candidates.length : null,
    first_candidate_keys: listObjectKeys(firstCandidate),
    first_candidate_finish_reason: String(firstCandidate?.finishReason || firstCandidate?.finish_reason || '').trim(),
    gemini_part_count: geminiParts.length,
    gemini_part_keys: geminiParts.slice(0, 5).map((part) => listObjectKeys(part, 8)),
    output_count: Array.isArray(parsed?.output) ? parsed.output.length : null,
    first_output_keys: listObjectKeys(firstOutput),
    has_error: Boolean(parsed?.error),
    error_keys: listObjectKeys(parsed?.error),
    error_message_preview: String(parsed?.error?.message || parsed?.message || '').slice(0, 240)
  };
}

function previewMalformedResponseData(data) {
  const text = typeof data === 'string'
    ? data
    : (data && typeof data === 'object' ? `[${Array.isArray(data) ? 'array' : 'object'}]` : String(data || ''));
  return String(text || '').slice(0, MALFORMED_RESPONSE_LOG_PREVIEW_CHARS);
}

function hasAssistantUsableContent(message = null) {
  if (!message || typeof message !== 'object') return false;
  const content = normalizeTextContent(message.content).trim();
  if (content) return true;
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function getNormalUserStreamFirstTokenTimeoutMs(resolvedConfig = null) {
  if (String(resolvedConfig?.__mainModelUserRole || '').trim().toLowerCase() === 'admin') return 0;
  return Math.max(0, Math.floor(Number(config.NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS) || 0));
}

function getAdminPrivateStreamFirstTokenTimeoutMs(resolvedConfig = null, context = {}) {
  if (String(resolvedConfig?.__mainModelUserRole || '').trim().toLowerCase() !== 'admin') return 0;
  if (!isAdminPrivateChatContext(context, config)) return 0;
  return Math.max(0, Math.floor(Number(config.ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS) || 0));
}

function getAdminPrivateStreamTotalTimeoutMs(resolvedConfig = null, context = {}) {
  if (String(resolvedConfig?.__mainModelUserRole || '').trim().toLowerCase() !== 'admin') return 0;
  if (!isAdminPrivateChatContext(context, config)) return 0;
  return Math.max(0, Math.floor(Number(config.ADMIN_PRIVATE_MAIN_REPLY_STREAM_TOTAL_TIMEOUT_MS) || 0));
}

function getAllowedToolNames(context = {}) {
  if (!Array.isArray(context.allowedTools)) return [];
  const runtimeConfig = context.runtimeConfig || context.config || config;
  const normalizedTools = normalizeToolNames(context.allowedTools);
  if (isAdminPrivateChatContext(context, runtimeConfig)) return normalizedTools;
  const companionTools = filterCompanionAllowedTools(normalizedTools, runtimeConfig);
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  if (!routeHasExplicitWebSearchRequirement({
    question: context.question || routeMeta.effectiveIntentText || routeMeta.cleanText,
    cleanText: context.cleanText || routeMeta.cleanText || routeMeta.effectiveIntentText,
    rawText: context.rawText || routeMeta.rawText,
    meta: routeMeta
  })) {
    return companionTools;
  }
  return normalizeToolNames([
    ...companionTools,
    ...normalizedTools.filter((toolName) => WEB_LOOKUP_ALLOWED_TOOLS.includes(toolName))
  ]);
}

const filteredToolSchemaCache = new Map();

function getFilteredToolSchemaCacheTtlMs() {
  return Math.max(1000, Number(
    config.FILTERED_TOOL_SCHEMA_CACHE_TTL_MS
    || process.env.FILTERED_TOOL_SCHEMA_CACHE_TTL_MS
  ) || FILTERED_TOOL_SCHEMA_CACHE_TTL_MS);
}

function getFilteredToolSchemaCacheMaxEntries() {
  return Math.max(1, Math.floor(Number(
    config.FILTERED_TOOL_SCHEMA_CACHE_MAX_ENTRIES
    || process.env.FILTERED_TOOL_SCHEMA_CACHE_MAX_ENTRIES
  ) || FILTERED_TOOL_SCHEMA_CACHE_MAX_ENTRIES));
}

function cloneToolSchema(schema = null) {
  if (!schema || typeof schema !== 'object') return schema;
  return {
    ...schema,
    function: schema.function ? { ...schema.function } : schema.function
  };
}

function pruneFilteredToolSchemaCache(maxEntries = getFilteredToolSchemaCacheMaxEntries()) {
  while (filteredToolSchemaCache.size > maxEntries) {
    const oldestKey = filteredToolSchemaCache.keys().next().value;
    if (oldestKey === undefined) break;
    filteredToolSchemaCache.delete(oldestKey);
  }
}

function getCachedFilteredToolSchemas(cacheKey = '', now = Date.now()) {
  if (!cacheKey) return null;
  const cached = filteredToolSchemaCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now || !Array.isArray(cached.schemas)) {
    if (cached) filteredToolSchemaCache.delete(cacheKey);
    return null;
  }
  filteredToolSchemaCache.delete(cacheKey);
  filteredToolSchemaCache.set(cacheKey, cached);
  return cached.schemas.map(cloneToolSchema);
}

function setCachedFilteredToolSchemas(cacheKey = '', schemas = [], now = Date.now()) {
  if (!cacheKey) return;
  filteredToolSchemaCache.set(cacheKey, {
    schemas: (Array.isArray(schemas) ? schemas : []).map(cloneToolSchema),
    expiresAt: now + getFilteredToolSchemaCacheTtlMs()
  });
  pruneFilteredToolSchemaCache();
}

function clearFilteredToolSchemaCache() {
  filteredToolSchemaCache.clear();
}

function getFilteredToolSchemaCacheStats() {
  return {
    size: filteredToolSchemaCache.size,
    maxEntries: getFilteredToolSchemaCacheMaxEntries(),
    ttlMs: getFilteredToolSchemaCacheTtlMs()
  };
}

function getFilteredToolSchemas(context = {}) {
  const allowedNames = getAllowedToolNames(context);
  if (context.disableTools || allowedNames.length === 0) return [];
  const cacheKey = JSON.stringify({
    allowedTools: allowedNames,
    disableTools: Boolean(context.disableTools)
  });
  const cached = getCachedFilteredToolSchemas(cacheKey);
  if (cached) return cached;
  const filtered = allowedNames
    .map((toolName) => getToolSchemaByName(toolName))
    .filter(Boolean);
  setCachedFilteredToolSchemas(cacheKey, filtered);
  return filtered.map(cloneToolSchema);
}

function finalizeStreamingReplyText(rawReply, fallbackText) {
  const text = sanitizeUserFacingText(normalizeTextContent(rawReply)).trim();
  return text || String(fallbackText || '').trim();
}

function buildReplyTextVariants(rawReply, fallbackText, options = {}) {
  const normalizedRaw = normalizeTextContent(rawReply);
  const visibleSanitized = sanitizeUserFacingText(normalizedRaw, {
    preserveThink: options.preserveThink === true,
    returnMeta: true
  });
  const persistedSanitized = sanitizeUserFacingText(normalizedRaw, {
    returnMeta: true
  });
  const visibleText = String(visibleSanitized?.text || '').trim() || String(fallbackText || '').trim();
  const persistedText = String(persistedSanitized?.text || '').trim() || String(fallbackText || '').trim();
  return {
    visibleText,
    persistedText,
    hasSafetyRestriction: Boolean(
      visibleSanitized?.hasSafetyRestriction
      || persistedSanitized?.hasSafetyRestriction
    )
  };
}

function buildModelCallTrace(context = {}, source = 'v2_model') {
  const requestTrace = normalizeRequestTrace(context?.requestTrace)
    || normalizeRequestTrace(context?.routeMeta?.requestTrace);
  const routeMeta = context?.routeMeta && typeof context.routeMeta === 'object'
    ? context.routeMeta
    : {};
  return {
    source: String(context?.source || source).trim() || source,
    phase: String(context?.phase || '').trim(),
    purpose: String(context?.purpose || '').trim(),
    requestId: String(requestTrace?.requestId || '').trim(),
    phaseSeq: Number.isFinite(Number(requestTrace?.phaseSeq || requestTrace?.phase_seq))
      ? Math.max(0, Math.floor(Number(requestTrace.phaseSeq || requestTrace.phase_seq)))
      : undefined,
    userId: String(context?.userId || context?.routeMeta?.userId || context?.routeMeta?.user_id || '').trim(),
    taskId: String(context?.taskId || '').trim(),
    routePolicyKey: String(context?.routePolicyKey || context?.routeMeta?.routePolicyKey || '').trim(),
    routeDebugKey: String(context?.routeDebugKey || routeMeta.routeDebugKey || routeMeta.route_debug_key || '').trim(),
    topRouteType: String(context?.topRouteType || context?.routeMeta?.topRouteType || '').trim(),
    dispatchBranch: String(context?.dispatchBranch || context?.replyBranch || '').trim(),
    triggerBranch: String(context?.triggerBranch || '').trim(),
    fallbackReason: String(context?.fallbackReason || routeMeta.routeFallbackReason || routeMeta.fallbackReason || '').trim(),
    memoryInjected: context?.memoryInjected
  };
}

function buildResolvedModelTrace(context = {}, resolvedConfig = null, source = 'v2_model') {
  const trace = buildModelCallTrace(context, source);
  const role = String(resolvedConfig?.__mainModelUserRole || '').trim();
  const warnings = Array.isArray(resolvedConfig?.__adminConfigWarnings)
    ? resolvedConfig.__adminConfigWarnings
    : [];
  const apiBaseUrl = getApiBaseUrl(resolvedConfig);
  const model = getModelName(resolvedConfig);
  const diagnostics = buildModelRouteDiagnostics({
    routeMeta: context?.routeMeta,
    routeDebugKey: trace.routeDebugKey,
    routePolicyKey: trace.routePolicyKey,
    topRouteType: trace.topRouteType,
    branch: trace.dispatchBranch,
    triggerBranch: trace.triggerBranch || source,
    provider: resolveMainProvider(apiBaseUrl, model, resolvedConfig),
    apiBaseUrl,
    model,
    modelSource: resolvedConfig?.__mainModelSource,
    apiBaseUrlSource: resolvedConfig?.__mainApiBaseUrlSource,
    apiKeySource: resolvedConfig?.__mainApiKeySource,
    fallbackReason: resolvedConfig?.__mainFallbackReason || trace.fallbackReason,
    fallbackScope: resolvedConfig?.__mainFallbackScope,
    fallbackActive: resolvedConfig?.__mainFallbackActive === true,
    fallbackForced: resolvedConfig?.__mainFallbackForced === true
  });
  return {
    ...trace,
    userRole: role,
    modelSource: String(resolvedConfig?.__mainModelSource || '').trim(),
    apiBaseUrlSource: String(resolvedConfig?.__mainApiBaseUrlSource || '').trim(),
    apiKeySource: String(resolvedConfig?.__mainApiKeySource || '').trim(),
    mainFallbackScope: String(resolvedConfig?.__mainFallbackScope || '').trim(),
    mainFallbackActive: resolvedConfig?.__mainFallbackActive === true,
    mainFallbackForced: resolvedConfig?.__mainFallbackForced === true,
    fallbackReason: String(resolvedConfig?.__mainFallbackReason || trace.fallbackReason || '').trim(),
    adminDedicatedModelConfigured: resolvedConfig?.__adminDedicatedModelConfigured,
    adminConfigWarnings: warnings,
    ...createModelRouteTracePatch(diagnostics)
  };
}

function logResolvedModelCall(context = {}, resolvedConfig = null, source = 'v2_model') {
  const trace = buildResolvedModelTrace(context, resolvedConfig, source);
  const logPayload = {
    source: trace.source,
    userId: trace.userId,
    userRole: trace.userRole || 'user',
    routePolicyKey: trace.routePolicyKey,
    routeDebugKey: trace.routeDebugKey,
    topRouteType: trace.topRouteType,
    dispatchBranch: trace.dispatchBranch,
    model: getModelName(resolvedConfig),
    provider: trace.provider,
    apiBaseUrlHost: trace.apiBaseUrlHost,
    modelSource: trace.modelSource,
    apiBaseUrlSource: trace.apiBaseUrlSource,
    fallbackScope: trace.mainFallbackScope,
    fallbackActive: trace.mainFallbackActive,
    fallbackForced: trace.mainFallbackForced,
    fallbackReason: trace.fallbackReason,
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
      persistedText: base,
      hasSafetyRestriction: variants.hasSafetyRestriction === true
    };
  }
  if (typeof options.shouldBypassHumanizerForPolicy === 'function' && options.shouldBypassHumanizerForPolicy(options?.routePolicyKey)) {
    return {
      visibleText: options.preserveThink === true ? variants.visibleText : base,
      persistedText: base,
      hasSafetyRestriction: variants.hasSafetyRestriction === true
    };
  }
  if (options.disableHumanizer) {
    return {
      visibleText: options.preserveThink === true ? variants.visibleText : base,
      persistedText: base,
      hasSafetyRestriction: variants.hasSafetyRestriction === true
    };
  }
  const humanized = await runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig),
    userId: options.userId,
    routeMeta: options.routeMeta,
    routePolicyKey: options.routePolicyKey,
    routeDebugKey: options.routeDebugKey || options.routeMeta?.routeDebugKey,
    topRouteType: options.topRouteType,
    requestTrace: options.requestTrace || options.routeMeta?.requestTrace,
    dispatchBranch: options.dispatchBranch || 'humanizer',
    triggerBranch: options.triggerBranch || 'humanizer.finalize_reply'
  });
  const persistedText = String(humanized || '').trim() || base;
  return {
    visibleText: options.preserveThink === true ? variants.visibleText : persistedText,
    persistedText,
    hasSafetyRestriction: variants.hasSafetyRestriction === true
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
      defaultMaxTokens: getMainReplyDefaultMaxTokens(),
      trace: callTrace,
      routeMeta: context?.routeMeta,
      topRouteType: context?.topRouteType,
      allowedTools: context?.allowedTools,
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
        maxOutputTokens: getMaxTokens(getMainReplyDefaultMaxTokens(), resolvedConfig),
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
  }, modelConfig, userId, {
    routeMeta: context?.routeMeta,
    requestTrace: context?.requestTrace || context?.routeMeta?.requestTrace
  });

  const message = extractMessageContent(response);
  if (hasAssistantUsableContent(message)) return message;

  const parseDiagnostic = summarizeMalformedResponse(response);
  recordModelCallParseFailure(response?.__modelCallId, {
    statusCode: Number(response?.status || 0) || null,
    parseDiagnostic,
    error: message
      ? 'assistant message parsed without usable text or tool calls'
      : 'model response parsed without usable assistant content'
  });
  console.error('AI response malformed(raw assistant):', previewMalformedResponseData(response?.data));
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
  let lastVisibleText = '';
  let firstVisibleOutputSeen = false;
  let cancelActiveFirstTokenTimer = null;
  const userId = String(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || '').trim();
  const preserveThink = options.preserveThink === true;

  const markFirstVisibleOutput = () => {
    firstVisibleOutputSeen = true;
    if (typeof cancelActiveFirstTokenTimer === 'function') {
      cancelActiveFirstTokenTimer();
      cancelActiveFirstTokenTimer = null;
    }
  };

  const emitVisibleDelta = (eventDelta = '') => {
    collected += eventDelta;
    const visibleCollected = sanitizeUserFacingText(collected, {
      preserveThink
    });
    const visibleDelta = extractUserFacingDelta(lastVisibleText, visibleCollected);
    if (visibleCollected !== lastVisibleText) {
      lastVisibleText = visibleCollected;
      options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
      if (options.streamHadOutput) {
        markFirstVisibleOutput();
      }
      if (typeof options.onDelta === 'function') {
        options.onDelta(visibleDelta, visibleCollected);
      }
    }
  };

  try {
    await withMainModelFallback(async (resolvedConfig) => {
      const requestStreamOnce = async (messages) => {
        const normalUserFirstTokenTimeoutMs = getNormalUserStreamFirstTokenTimeoutMs(resolvedConfig);
        const adminPrivateFirstTokenTimeoutMs = getAdminPrivateStreamFirstTokenTimeoutMs(resolvedConfig, options);
        const adminPrivateTotalTimeoutMs = getAdminPrivateStreamTotalTimeoutMs(resolvedConfig, options);
        const firstTokenTimeoutMs = normalUserFirstTokenTimeoutMs || adminPrivateFirstTokenTimeoutMs;
        const firstTokenTimeoutType = normalUserFirstTokenTimeoutMs > 0 ? 'normal_user' : (adminPrivateFirstTokenTimeoutMs > 0 ? 'admin_private' : '');
        const useFirstTokenTimeout = firstTokenTimeoutMs > 0 && !firstVisibleOutputSeen;
        const useTotalTimeout = adminPrivateTotalTimeoutMs > 0;
        const requestTimeoutMs = useTotalTimeout
          ? adminPrivateTotalTimeoutMs
          : 0;
        const abortController = (useFirstTokenTimeout || useTotalTimeout) && typeof AbortController !== 'undefined'
          ? new AbortController()
          : null;
        const callTrace = logResolvedModelCall(options, resolvedConfig, 'v2_streaming_reply');
        const request = buildMainModelRequest(resolvedConfig, {
          messages,
          stream: true,
          defaultMaxTokens: getMainReplyDefaultMaxTokens(),
          trace: callTrace,
          routeMeta: options?.routeMeta,
          topRouteType: options?.topRouteType,
          allowedTools: options?.allowedTools
        });
        const requestBody = {
          ...request.body,
          ...(abortController ? { __abortSignal: abortController.signal } : {}),
          ...(requestTimeoutMs > 0 ? { __timeoutMs: requestTimeoutMs } : {})
        };
        const streamPromise = postStreamWithRetry(
          request.url,
          requestBody,
          {
            onData(chunk) {
              const parsed = extractSSEEvents(parserState, chunk);
              parserState.buffer = parsed.state.buffer;
              for (const event of parsed.events) {
                if (!event || event.done || !event.delta) continue;
                emitVisibleDelta(event.delta);
              }
            }
          },
          getRetries(1, resolvedConfig),
          getApiKey(resolvedConfig)
        );
        if (!useFirstTokenTimeout && !useTotalTimeout) {
          await streamPromise;
          return;
        }

        let timeoutError = null;
        let firstTokenTimer = null;
        let totalTimer = null;
        const timeoutPromise = new Promise((_, reject) => {
          const rejectWithTimeout = (error) => {
            timeoutError = error;
            if (abortController && !abortController.signal.aborted) {
              try { abortController.abort(timeoutError); } catch (_) {}
            }
            reject(timeoutError);
          };
          if (useFirstTokenTimeout) {
            firstTokenTimer = setTimeout(() => {
              if (firstVisibleOutputSeen) return;
              rejectWithTimeout(firstTokenTimeoutType === 'admin_private'
                ? createAdminPrivateMainReplyStreamFirstTokenTimeoutError(firstTokenTimeoutMs)
                : createNormalUserMainReplyStreamFirstTokenTimeoutError(firstTokenTimeoutMs));
            }, firstTokenTimeoutMs);
          }
          if (useTotalTimeout) {
            totalTimer = setTimeout(() => {
              rejectWithTimeout(createAdminPrivateMainReplyStreamFirstTokenTimeoutError(adminPrivateTotalTimeoutMs, {
                timeoutKind: 'total'
              }));
            }, adminPrivateTotalTimeoutMs);
          }
          cancelActiveFirstTokenTimer = () => {
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          };
        });
        const cancelAllTimers = () => {
          if (typeof cancelActiveFirstTokenTimer === 'function') {
            cancelActiveFirstTokenTimer();
            cancelActiveFirstTokenTimer = null;
          }
          if (totalTimer) {
            clearTimeout(totalTimer);
            totalTimer = null;
          }
        };

        try {
          await Promise.race([streamPromise, timeoutPromise]);
        } catch (error) {
          if (timeoutError) throw timeoutError;
          throw error;
        } finally {
          cancelAllTimers();
        }
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
          maxOutputTokens: getMaxTokens(getMainReplyDefaultMaxTokens(), resolvedConfig),
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
    }, modelConfig, userId, {
      routeMeta: options?.routeMeta,
      requestTrace: options?.requestTrace || options?.routeMeta?.requestTrace
    });
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
    emitVisibleDelta(event.delta);
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
    maxSegments: Number(config.AI_STREAM_MAX_SEGMENTS) || 3,
    userId: options.userId,
    routeMeta: options.routeMeta,
    routePolicyKey: options.routePolicyKey,
    routeDebugKey: options.routeDebugKey || options.routeMeta?.routeDebugKey,
    topRouteType: options.topRouteType,
    requestTrace: options.requestTrace || options.routeMeta?.requestTrace,
    dispatchBranch: options.dispatchBranch || 'humanizer',
    triggerBranch: options.triggerBranch || 'humanizer.streaming'
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
  clearFilteredToolSchemaCache,
  getFilteredToolSchemaCacheStats,
  getFilteredToolSchemas,
  requestAssistantMessage,
  requestNonStreamingReply,
  requestStreamingReply,
  shouldUseStreamingReply,
  withMainModelFallback,
  _test: {
    filteredToolSchemaCache,
    getCachedFilteredToolSchemas,
    getFilteredToolSchemaCacheMaxEntries,
    getFilteredToolSchemaCacheTtlMs,
    pruneFilteredToolSchemaCache,
    setCachedFilteredToolSchemas,
    summarizeMalformedResponse
  }
};
