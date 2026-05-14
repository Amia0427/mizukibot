const {
  applyAnthropicCacheControl,
  applyAnthropicCacheControlToBlockIndex,
  applyAnthropicCacheControlToLastBlock,
  applyAutoAnthropicPromptCaching,
  ANTHROPIC_ASSISTANT_CONTEXT_PREFIX,
  appendRequestTraceEvent,
  anthropicRequestUsesPromptCaching,
  blockHasAnthropicCacheControl,
  buildModelRouteDiagnostics,
  clampTemperatureForProvider,
  coerceTrailingAnthropicAssistantContextToUser,
  config,
  extractErrorCode,
  extractAnthropicCacheControl,
  extractAnthropicMessageCacheControl,
  extractHttpStatus,
  extractInputMessageText,
  isAnthropicAssistantOnlyContextText,
  isAnthropicDynamicSystemContextText,
  mergeAnthropicBetaHeader,
  nextTracePhase,
  normalizeJsonObject,
  normalizeProviderRequestHeaders,
  normalizeText,
  providerAllowsCacheControl,
  providerAllowsOpenAIPromptCache,
  serializeAnthropicToolResultContent,
  splitAnthropicStableSystemText,
  stripAnthropicCacheControlFromBlocks,
  stripCacheControlFields,
  stripCacheControlFieldsDeep,
  stripOpenAIPromptCacheFields,
  stripOpenAIPromptCacheRetention,
  stripTopPField
} = require('./runtime-core.chunk');
const {
  sanitizeOpenAICompatibleToolWithoutCache,
  toAnthropicContentBlocks
} = require('./images.chunk');

function isAnthropicPromptCacheSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /cache[_-]?control|prompt[_-]?cache|prompt-caching-2024-07-31|anthropic-beta|unknown field|unsupported beta|extra inputs|additional properties/i.test(bodyText);
}

function normalizeReasoningEffort(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return '';
  if (['0', 'false', 'no', 'off', 'none', 'disabled', 'disable'].includes(normalized)) return '';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'high';
}

function getAnthropicThinkingBudget(maxTokens, effort) {
  const normalized = normalizeReasoningEffort(effort);
  if (!normalized) return 0;
  const outputTokens = Number(maxTokens);
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return 0;
  const defaults = {
    minimal: 1024,
    low: 1024,
    medium: 2048,
    high: 4096
  };
  return Math.min(
    defaults[normalized] || defaults.high,
    Math.max(1024, Math.floor(outputTokens * 0.6)),
    Math.max(0, Math.floor(outputTokens) - 1)
  );
}

function requestUsesReasoning(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return false;
  return Boolean(requestBody.reasoning_effort || requestBody.reasoning || requestBody.thinking);
}

function stripReasoningFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  const originalMaxTokens = Number(requestBody.__originalMaxTokens);
  delete nextBody.reasoning_effort;
  delete nextBody.reasoning;
  delete nextBody.thinking;
  delete nextBody.__originalMaxTokens;
  if (Number.isFinite(originalMaxTokens) && originalMaxTokens > 0) {
    nextBody.max_tokens = Math.floor(originalMaxTokens);
  }
  return nextBody;
}

function requestUsesExtendedSampling(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(requestBody, 'top_k')
    || Object.prototype.hasOwnProperty.call(requestBody, 'top_a')
    || Object.prototype.hasOwnProperty.call(requestBody, 'repetition_penalty');
}

function stripExtendedSamplingFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  delete nextBody.top_k;
  delete nextBody.top_a;
  delete nextBody.repetition_penalty;
  return nextBody;
}

function stripProviderCacheFields(provider = 'openai_compatible', requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return requestBody;
  let nextBody = requestBody;
  if (!providerAllowsOpenAIPromptCache(provider)) {
    nextBody = stripOpenAIPromptCacheFields(nextBody);
  }
  if (!providerAllowsCacheControl(provider)) {
    nextBody = stripCacheControlFieldsDeep(nextBody);
  }
  return nextBody;
}

function stripInternalRequestFields(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = { ...requestBody };
  delete nextBody.__trace;
  delete nextBody.__timeoutMs;
  delete nextBody.__abortSignal;
  delete nextBody.__requestHeaders;
  delete nextBody.__originalMaxTokens;
  return nextBody;
}

function countCacheControlBlocks(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCacheControlBlocks(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  let total = extractAnthropicCacheControl(value) ? 1 : 0;
  total += countCacheControlBlocks(value.content);
  total += countCacheControlBlocks(value.function);
  return total;
}

function buildRequestCacheTrace(requestBody = {}, requestHeaders = {}) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const promptCaching = {
    openaiPromptCacheKey: normalizeText(body.prompt_cache_key),
    openaiPromptCacheRetention: normalizeText(body.prompt_cache_retention),
    anthropicCacheBreakpoints: 0,
    anthropicPromptCacheTtl: '',
    anthropicBeta: normalizeText((requestHeaders || {})['anthropic-beta'] || (requestHeaders || {})['Anthropic-Beta'])
  };

  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.system);
  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.messages);
  promptCaching.anthropicCacheBreakpoints += countCacheControlBlocks(body.tools);

  const findTtl = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const ttl = findTtl(item);
        if (ttl) return ttl;
      }
      return '';
    }
    if (!value || typeof value !== 'object') return '';
    if (value.cache_control && typeof value.cache_control === 'object') {
      return normalizeText(value.cache_control.ttl);
    }
    return findTtl(value.content) || findTtl(value.function);
  };
  promptCaching.anthropicPromptCacheTtl = findTtl(body.system) || findTtl(body.messages) || findTtl(body.tools);
  return promptCaching;
}

function emitHttpTrace(trace = {}, phase = '', payload = {}) {
  const requestId = normalizeText(trace?.requestId || trace?.request_id);
  if (!requestId) return;
  const diagnostics = trace?.modelRouteDiagnostic && typeof trace.modelRouteDiagnostic === 'object'
    ? trace.modelRouteDiagnostic
    : buildModelRouteDiagnostics({
        routeDebugKey: trace?.routeDebugKey,
        routePolicyKey: trace?.routePolicyKey || trace?.route_policy_key,
        topRouteType: trace?.topRouteType || trace?.top_route_type,
        branch: trace?.dispatchBranch || trace?.branch,
        triggerBranch: trace?.triggerBranch || phase,
        provider: payload.provider || trace?.provider,
        apiBaseUrl: trace?.apiBaseUrl || payload.requestUrl,
        model: payload.model || trace?.model,
        modelSource: trace?.modelSource,
        apiBaseUrlSource: trace?.apiBaseUrlSource,
        apiKeySource: trace?.apiKeySource,
        fallbackReason: trace?.fallbackReason,
        fallbackScope: trace?.mainFallbackScope,
        fallbackActive: trace?.mainFallbackActive === true,
        fallbackForced: trace?.mainFallbackForced === true
      });
  appendRequestTraceEvent(nextTracePhase(trace, phase, {
    tracePhase: normalizeText(phase || trace.phase || 'httpClient') || 'httpClient',
    stage: normalizeText(payload.stage || phase || trace.phase || 'http_client'),
    source: normalizeText(trace.source || 'httpClient') || 'httpClient',
    purpose: normalizeText(trace.purpose),
    userId: normalizeText(trace.userId || trace.user_id),
    routePolicyKey: normalizeText(trace.routePolicyKey || trace.route_policy_key),
    routeDebugKey: normalizeText(trace.routeDebugKey || diagnostics.routeDebugKey),
    topRouteType: normalizeText(trace.topRouteType || trace.top_route_type),
    dispatchBranch: normalizeText(trace.dispatchBranch || diagnostics.branch),
    triggerBranch: normalizeText(trace.triggerBranch || diagnostics.triggerBranch),
    apiBaseUrl: normalizeText(trace.apiBaseUrl || diagnostics.apiBaseUrl),
    apiBaseUrlHost: normalizeText(trace.apiBaseUrlHost || diagnostics.apiBaseUrlHost),
    modelSource: normalizeText(trace.modelSource || diagnostics.modelSource),
    apiBaseUrlSource: normalizeText(trace.apiBaseUrlSource || diagnostics.apiBaseUrlSource),
    apiKeySource: normalizeText(trace.apiKeySource || diagnostics.apiKeySource),
    fallbackReason: normalizeText(trace.fallbackReason || diagnostics.fallbackReason),
    mainFallbackScope: normalizeText(trace.mainFallbackScope || diagnostics.fallbackScope),
    mainFallbackActive: trace.mainFallbackActive === true || diagnostics.fallbackActive === true,
    mainFallbackForced: trace.mainFallbackForced === true || diagnostics.fallbackForced === true,
    modelRouteDiagnostic: diagnostics,
    ...payload
  }));
}

function emitHttpSuccessTrace(trace = {}, prepared = {}, body = {}, payload = {}) {
  emitHttpTrace(trace, 'http_client_success', {
    stage: 'http_client_success',
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    fallbackActive: trace?.mainFallbackActive === true,
    ...payload
  });
}

function emitHttpFailureTrace(trace = {}, prepared = {}, body = {}, error = null, payload = {}) {
  emitHttpTrace(trace, 'http_client_failure', {
    stage: 'http_client_failure',
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    statusCode: extractHttpStatus(error) || null,
    finalErrorCode: extractErrorCode(error),
    error: normalizeText(error?.message || error).slice(0, 400),
    fallbackActive: trace?.mainFallbackActive === true,
    ...payload
  });
}

function emitHttpDowngradeTrace(trace = {}, prepared = {}, body = {}, reason = '', error = null, payload = {}) {
  emitHttpTrace(trace, 'http_client_request_downgrade', {
    stage: 'http_client_request_downgrade',
    reason,
    provider: prepared?.provider,
    model: prepared?.requestBody?.model || body?.model || '',
    requestUrl: prepared?.requestUrl,
    statusCode: extractHttpStatus(error) || null,
    ...payload
  });
}

function extractInternalRequestHeaders(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return null;
  const rawHeaders = requestBody.__requestHeaders;
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return null;

  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(rawHeaders)) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : null;
}

function extractProviderRequestHeaders(provider = 'openai_compatible', requestBody = {}) {
  return normalizeProviderRequestHeaders(provider, extractInternalRequestHeaders(requestBody));
}

function isReasoningSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /reasoning|reasoning[_-]?effort|thinking|budget[_-]?tokens|unsupported.*(?:field|parameter)|unknown field|extra inputs|additional properties/i.test(bodyText);
}

function isExtendedSamplingSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /top[_-]?k|top[_-]?a|repetition[_-]?penalty|unsupported.*(?:field|parameter)|unknown field|unknown parameter|extra inputs|additional properties/i.test(bodyText);
}

function mapToolSchemaToAnthropic(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type !== 'function') return null;

  const fn = tool.function || {};
  const name = normalizeText(fn.name);
  if (!name) return null;

  return {
    name,
    description: normalizeText(fn.description),
    input_schema: (fn.parameters && typeof fn.parameters === 'object')
      ? fn.parameters
      : { type: 'object', properties: {} }
  };
}

function mapToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return null;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    return null;
  }

  const type = String(toolChoice.type || '').toLowerCase();
  if (type === 'auto') return { type: 'auto' };
  if (type === 'any' || type === 'required') return { type: 'any' };
  if (type === 'function') {
    const name = normalizeText(toolChoice?.function?.name);
    return name ? { type: 'tool', name } : null;
  }
  if (type === 'tool') {
    const name = normalizeText(toolChoice?.name);
    return name ? { type: 'tool', name } : null;
  }

  return null;
}

function inferMessageRole(item) {
  const explicitRole = normalizeText(item?.role).toLowerCase();
  if (explicitRole) return explicitRole;

  if (typeof item?._getType === 'function') {
    const lcType = normalizeText(item._getType()).toLowerCase();
    if (lcType === 'system') return 'system';
    if (lcType === 'tool') return 'tool';
    if (lcType === 'ai') return 'assistant';
    if (lcType === 'human') return 'user';
  }

  if (normalizeText(item?.tool_call_id || item?.tool_use_id)) return 'tool';
  if (Array.isArray(item?.tool_calls) && item.tool_calls.length > 0) return 'assistant';
  return 'user';
}

async function mapMessagesToAnthropic(messages) {
  const systemBlocks = [];
  const out = [];

  const items = Array.isArray(messages) ? messages : [];
  for (const item of items) {
    const role = inferMessageRole(item);
    const messageCacheControl = extractAnthropicMessageCacheControl(item);

    if (role === 'system') {
      const rawSystemText = typeof item?.content === 'string'
        ? item.content
        : ((Array.isArray(item?.content) && item.content.every((block) => typeof block?.text === 'string'))
          ? item.content.map((block) => String(block.text || '')).join('\n')
          : '');
      const splitSystem = splitAnthropicStableSystemText(rawSystemText);
      if (splitSystem) {
        const stableBlocks = applyAnthropicCacheControlToLastBlock(
          (await toAnthropicContentBlocks(splitSystem.stableText))
            .filter((block) => block?.type === 'text'),
          messageCacheControl || true
        );
        if (stableBlocks.length > 0) systemBlocks.push(...stableBlocks);

        const dynamicBlocks = await toAnthropicContentBlocks(`${ANTHROPIC_ASSISTANT_CONTEXT_PREFIX}\n${splitSystem.dynamicText}`);
        if (dynamicBlocks.length > 0) {
          out.push({
            role: 'assistant',
            content: dynamicBlocks
          });
        }
        continue;
      }

      if (isAnthropicDynamicSystemContextText(rawSystemText)) {
        const contextBlocks = await toAnthropicContentBlocks(`${ANTHROPIC_ASSISTANT_CONTEXT_PREFIX}\n${rawSystemText}`);
        if (contextBlocks.length > 0) {
          out.push({
            role: 'assistant',
            content: contextBlocks
          });
        }
        continue;
      }

      const blocks = applyAnthropicCacheControlToLastBlock(
        (await toAnthropicContentBlocks(item?.content))
          .filter((block) => block?.type === 'text'),
        messageCacheControl
      );
      if (blocks.length > 0) systemBlocks.push(...blocks);
      continue;
    }

    if (role === 'tool') {
      const toolUseId = normalizeText(item?.tool_call_id || item?.tool_use_id) || `tool_${Date.now()}`;
      const toolResultBlocks = await toAnthropicContentBlocks(item?.content);

      out.push({
        role: 'user',
        content: [
          applyAnthropicCacheControl({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: serializeAnthropicToolResultContent(toolResultBlocks)
          }, messageCacheControl)
        ]
      });
      continue;
    }

    if (role === 'assistant') {
      let blocks = await toAnthropicContentBlocks(item?.content);
      const allowAssistantCacheControl = !isAnthropicAssistantOnlyContextText(extractInputMessageText(item));
      const toolCalls = Array.isArray(item?.tool_calls) ? item.tool_calls : [];

      for (const call of toolCalls) {
        const toolName = normalizeText(call?.function?.name || call?.name);
        if (!toolName) continue;

        blocks.push({
          type: 'tool_use',
          id: normalizeText(call?.id) || `tooluse_${Date.now()}`,
          name: toolName,
          input: normalizeJsonObject(call?.function?.arguments || call?.args)
        });
      }

      blocks = allowAssistantCacheControl
        ? applyAnthropicCacheControlToLastBlock(blocks, messageCacheControl)
        : stripAnthropicCacheControlFromBlocks(blocks);

      out.push({
        role: 'assistant',
        content: blocks.length ? blocks : [{ type: 'text', text: '' }]
      });
      continue;
    }

    const userBlocks = applyAnthropicCacheControlToLastBlock(
      await toAnthropicContentBlocks(item?.content),
      messageCacheControl
    );
    out.push({
      role: 'user',
      content: userBlocks.length ? userBlocks : [{ type: 'text', text: '' }]
    });
  }

  return {
    system: systemBlocks,
    messages: coerceTrailingAnthropicAssistantContextToUser(
      out.length ? out : [{ role: 'user', content: [{ type: 'text', text: '(empty input)' }] }]
    )
  };
}

async function buildAnthropicRequestBody(body = {}) {
  const inputBody = stripTopPField(body);
  const mapped = await mapMessagesToAnthropic(inputBody.messages);
  const maxTokens = Number(inputBody.max_tokens);
  const visibleMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024;

  const requestBody = {
    model: normalizeText(inputBody.model) || normalizeText(config.AI_MODEL) || 'claude-3-5-sonnet-latest',
    max_tokens: visibleMaxTokens,
    messages: mapped.messages,
    stream: Boolean(inputBody.stream)
  };

  if (mapped.system.length > 0) requestBody.system = mapped.system;

  const temperature = clampTemperatureForProvider('anthropic', inputBody.temperature);
  if (temperature !== null) requestBody.temperature = temperature;

  const topP = Number(inputBody.top_p);
  if (Number.isFinite(topP)) requestBody.top_p = topP;

  const topK = Number(inputBody.top_k);
  if (Number.isFinite(topK) && topK > 0) requestBody.top_k = Math.floor(topK);

  if (Array.isArray(inputBody.stop)) {
    const stops = inputBody.stop.map((x) => String(x || '').trim()).filter(Boolean);
    if (stops.length) requestBody.stop_sequences = stops;
  }

  if (Array.isArray(inputBody.tools)) {
    const tools = inputBody.tools
      .map(mapToolSchemaToAnthropic)
      .filter(Boolean);
    if (tools.length) {
      requestBody.tools = tools;
      const choice = mapToolChoiceToAnthropic(inputBody.tool_choice);
      if (choice) requestBody.tool_choice = choice;
    }
  }

  const reasoningEffort = normalizeReasoningEffort(inputBody.reasoning_effort);
  const thinkingBudget = getAnthropicThinkingBudget(Math.max(visibleMaxTokens, 1200), reasoningEffort);
  if (thinkingBudget > 0) {
    requestBody.max_tokens = Math.max(visibleMaxTokens + thinkingBudget, 1200);
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget
    };
    requestBody.__originalMaxTokens = visibleMaxTokens;
  }

  return applyAutoAnthropicPromptCaching(requestBody);
}

module.exports = {
  buildAnthropicRequestBody,
  buildRequestCacheTrace,
  countCacheControlBlocks,
  emitHttpDowngradeTrace,
  emitHttpFailureTrace,
  emitHttpSuccessTrace,
  emitHttpTrace,
  extractInternalRequestHeaders,
  extractProviderRequestHeaders,
  getAnthropicThinkingBudget,
  inferMessageRole,
  isAnthropicPromptCacheSchemaError,
  isExtendedSamplingSchemaError,
  isReasoningSchemaError,
  mapMessagesToAnthropic,
  mapToolChoiceToAnthropic,
  mapToolSchemaToAnthropic,
  normalizeReasoningEffort,
  requestUsesExtendedSampling,
  requestUsesReasoning,
  stripExtendedSamplingFields,
  stripInternalRequestFields,
  stripProviderCacheFields,
  stripReasoningFields
};

