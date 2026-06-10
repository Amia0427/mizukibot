const {
  axios,
  createModelRouteTracePatch,
  extractErrorCode,
  extractHttpStatus,
  extractSSEEvents,
  failModelCall,
  finishModelCall,
  flushSSEState,
  mergeUsageObjects,
  normalizeText,
  startModelCall,
  buildAnthropicRequestHeaders,
  buildModelRouteDiagnostics
} = require('./runtime-core.chunk');
const {
  buildOpenAICompatibleImageFallbackText,
  resolveAnthropicImageBlock,
  resolveOpenAICompatibleImagePart
} = require('./images.chunk');
const {
  buildResponsesRequestBody,
  buildChatCompletionsFallbackUrl,
  markResponsesProtocolFallbackAttempted,
  preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache,
  shouldFallbackResponsesProtocol
} = require('./openai-compatible.chunk');
const { mapMessagesToAnthropic } = require('./request-shaping.chunk');
const {
  buildPinnedLookup,
  getAxiosOptions,
  getFirstTokenTimeoutMs,
  getRetryDelayMs,
  getRetryTimeoutMs,
  getStreamAxiosOptions,
  getStreamTimeoutMs,
  prepareRequest,
  shouldRetryStreamRequest,
  validatePreparedEndpoint,
  buildRequestCacheTrace
} = require('./prepare.chunk');
const {
  anthropicRequestUsesPromptCaching,
  stripAnthropicAutomaticPromptCaching,
  stripAnthropicPromptCaching
} = require('./runtime-core.chunk');
const {
  emitHttpDowngradeTrace,
  emitHttpFailureTrace,
  emitHttpSuccessTrace,
  emitHttpTrace,
  isAnthropicPromptCacheSchemaError,
  isExtendedSamplingSchemaError,
  isReasoningSchemaError,
  isTemperatureSchemaError,
  isTemperatureTopPConflictError,
  requestUsesExtendedSampling,
  requestUsesReasoning,
  requestUsesTemperature,
  requestUsesTopP,
  stripExtendedSamplingFields,
  stripReasoningFields,
  stripTemperatureField,
  stripTopPRequestField
} = require('./request-shaping.chunk');
const {
  isOpenAICompatiblePromptCacheSchemaError,
  isOpenAIPromptCacheRetentionSchemaError,
  requestUsesOpenAICompatiblePromptCaching,
  requestUsesOpenAIPromptCacheRetention,
  stripOpenAICompatiblePromptCaching,
  stripOpenAIPromptCacheRetentionFromRequest
} = require('./openai-compatible.chunk');
const { postWithRetry } = require('./post-retry.chunk');

/**
 * Streaming POST request with retry support.
 * The caller receives raw chunks and handles SSE parsing.
 */
async function postStreamWithRetry(url, body, handlers = {}, retries = 1, specificKey = null) {
  let lastErr;
  const maxRetry = Math.max(0, Number(retries) || 0);
  const onResponse = typeof handlers.onResponse === 'function' ? handlers.onResponse : null;
  const onData = typeof handlers.onData === 'function' ? handlers.onData : null;
  const onDone = typeof handlers.onDone === 'function' ? handlers.onDone : null;
  const abortSignal = body && typeof body === 'object' && body.__abortSignal
    ? body.__abortSignal
    : null;
  if (abortSignal && typeof abortSignal.addEventListener === 'function') {
    abortSignal.addEventListener('abort', () => {
      handlers.__abort_requested = true;
    }, { once: true });
  }
  const trace = body && typeof body === 'object' && body.__trace && typeof body.__trace === 'object'
    ? body.__trace
    : {};
  const streamFailureTraceEmitted = new WeakSet();
  let fallbackProtocolFailed = false;

  for (let i = 0; i <= maxRetry; i++) {
    let stream = null;
    let callId = '';
    let prepared = null;
    let pinnedLookup = null;
    const usageParserState = { buffer: '' };
    let streamUsage = null;
    let streamFinishReason = '';
    let streamDoneSeen = false;
    const attemptStartedAt = Date.now();

    try {
      const timeoutMs = getRetryTimeoutMs(getStreamTimeoutMs(), i, 30000, 300000);
      prepared = await prepareRequest(url, body);
      pinnedLookup = buildPinnedLookup(await validatePreparedEndpoint(prepared.requestUrl));
      const routeDiagnostics = buildModelRouteDiagnostics({
        ...trace,
        provider: prepared.provider,
        apiBaseUrl: prepared.requestUrl,
        model: prepared.requestBody?.model || body?.model || ''
      });
      Object.assign(trace, createModelRouteTracePatch(routeDiagnostics));
      emitHttpTrace(trace, 'http_client_start', {
        stage: 'http_client_start',
        attempt: i + 1,
        maxAttempts: maxRetry + 1,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model || '',
        requestUrl: prepared.requestUrl,
        stream: true,
        cache: buildRequestCacheTrace(prepared.requestBody, prepared.requestHeaders),
        fallbackActive: trace.mainFallbackActive === true,
        fallbackScope: trace.mainFallbackScope || ''
      });
      callId = startModelCall({
        source: trace.source || 'httpClient',
        phase: trace.phase || '',
        purpose: trace.purpose || '',
        requestId: trace.requestId || '',
        phaseSeq: trace.phaseSeq,
        userId: trace.userId || '',
        taskId: trace.taskId || '',
        routePolicyKey: trace.routePolicyKey || '',
        routeDebugKey: trace.routeDebugKey || '',
        topRouteType: trace.topRouteType || '',
        dispatchBranch: trace.dispatchBranch || '',
        triggerBranch: trace.triggerBranch || '',
        apiBaseUrl: trace.apiBaseUrl || prepared.requestUrl,
        apiBaseUrlHost: trace.apiBaseUrlHost || '',
        fallbackReason: trace.fallbackReason || '',
        userRole: trace.userRole || '',
        modelSource: trace.modelSource || '',
        apiBaseUrlSource: trace.apiBaseUrlSource || '',
        apiKeySource: trace.apiKeySource || '',
        mainFallbackScope: trace.mainFallbackScope || '',
        mainFallbackActive: trace.mainFallbackActive === true,
        mainFallbackForced: trace.mainFallbackForced === true,
        modelRouteDiagnostic: trace.modelRouteDiagnostic,
        adminDedicatedModelConfigured: trace.adminDedicatedModelConfigured,
        url: prepared.requestUrl,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders,
        memoryInjected: trace.memoryInjected
      });
      let resp;
      try {
        resp = await axios.post(
          prepared.requestUrl,
          prepared.requestBody,
          getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
        );
        } catch (error) {
        if (requestUsesReasoning(prepared?.requestBody) && isReasoningSchemaError(error)) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_reasoning_fields', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripReasoningFields(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (shouldFallbackResponsesProtocol(prepared, body, error)) {
          const fallbackUrl = buildChatCompletionsFallbackUrl(prepared.requestUrl);
          const fallbackBody = markResponsesProtocolFallbackAttempted(body);
          emitHttpDowngradeTrace(trace, prepared, body, 'fallback_chat_completions_protocol', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            fallbackRequestUrl: fallbackUrl
          });
          try {
            await postStreamWithRetry(
              fallbackUrl,
              fallbackBody,
              handlers,
              Math.max(0, maxRetry - i),
              specificKey
            );
            finishModelCall(callId, {
              attempts: i + 1,
              requestUrl: fallbackUrl,
              request: fallbackBody,
              requestHeaders: prepared.requestHeaders
            });
            return true;
          } catch (fallbackError) {
            fallbackProtocolFailed = true;
            throw fallbackError;
          }
        } else if (requestUsesExtendedSampling(prepared?.requestBody) && isExtendedSamplingSchemaError(error)) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_extended_sampling_fields', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripExtendedSamplingFields(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (requestUsesTemperature(prepared?.requestBody) && isTemperatureSchemaError(error)) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_temperature_field', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripTemperatureField(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (
          requestUsesTemperature(prepared?.requestBody)
          && requestUsesTopP(prepared?.requestBody)
          && isTemperatureTopPConflictError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_top_p_field', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripTopPRequestField(prepared.requestBody);
          resp = await axios.post(
            prepared.requestUrl,
            strippedRequestBody,
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          prepared = {
            ...prepared,
            requestBody: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          };
        } else if (
          prepared?.provider === 'openai_compatible'
          && requestUsesOpenAIPromptCacheRetention(prepared.requestBody)
          && isOpenAIPromptCacheRetentionSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache_retention', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const strippedRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          try {
            resp = await axios.post(
              prepared.requestUrl,
              strippedRequestBody,
              getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
            );
            prepared = {
              ...prepared,
              requestBody: strippedRequestBody,
              requestHeaders: prepared.requestHeaders
            };
          } catch (retryWithoutRetentionError) {
            if (
              requestUsesOpenAICompatiblePromptCaching(strippedRequestBody)
              && isOpenAICompatiblePromptCacheSchemaError(retryWithoutRetentionError)
            ) {
              emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache', retryWithoutRetentionError, {
                attempt: i + 1,
                durationMs: Math.max(0, Date.now() - attemptStartedAt)
              });
              const strippedCacheRequestBody = stripOpenAICompatiblePromptCaching(strippedRequestBody);
              resp = await axios.post(
                prepared.requestUrl,
                strippedCacheRequestBody,
                getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
              );
              prepared = {
                ...prepared,
                requestBody: strippedCacheRequestBody,
                requestHeaders: prepared.requestHeaders
              };
            } else {
              throw retryWithoutRetentionError;
            }
          }
        } else if (
          prepared?.provider === 'openai_compatible'
          && requestUsesOpenAICompatiblePromptCaching(prepared.requestBody)
          && isOpenAICompatiblePromptCacheSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_openai_prompt_cache', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          resp = await axios.post(
            prepared.requestUrl,
            stripOpenAICompatiblePromptCaching(prepared.requestBody),
            getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          prepared = {
            ...prepared,
            requestBody: stripOpenAICompatiblePromptCaching(prepared.requestBody),
            requestHeaders: prepared.requestHeaders
          };
        } else if (
          prepared?.provider === 'anthropic'
          && anthropicRequestUsesPromptCaching(prepared.requestBody)
          && isAnthropicPromptCacheSchemaError(error)
        ) {
          emitHttpDowngradeTrace(trace, prepared, body, 'strip_anthropic_prompt_cache', error, {
            attempt: i + 1,
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          const automaticDowngrade = stripAnthropicAutomaticPromptCaching(prepared.requestBody, prepared.requestHeaders);
          try {
            resp = await axios.post(
              prepared.requestUrl,
              automaticDowngrade.requestBody,
              getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, automaticDowngrade.requestHeaders, abortSignal, pinnedLookup)
            );
            prepared = {
              ...prepared,
              requestBody: automaticDowngrade.requestBody,
              requestHeaders: automaticDowngrade.requestHeaders
            };
          } catch (automaticDowngradeError) {
            if (!anthropicRequestUsesPromptCaching(automaticDowngrade.requestBody) || !isAnthropicPromptCacheSchemaError(automaticDowngradeError)) {
              throw automaticDowngradeError;
            }
            const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
            resp = await axios.post(
              prepared.requestUrl,
              downgraded.requestBody,
              getStreamAxiosOptions(prepared.provider, specificKey, timeoutMs, downgraded.requestHeaders, abortSignal, pinnedLookup)
            );
            prepared = {
              ...prepared,
              requestBody: downgraded.requestBody,
              requestHeaders: downgraded.requestHeaders
            };
          }
        } else {
          throw error;
        }
      }
      stream = resp?.data;
      if (!stream || typeof stream.on !== 'function') {
        throw new Error('Streaming response is not a readable stream');
      }

      if (onResponse) onResponse(resp);

      await new Promise((resolve, reject) => {
        let settled = false;
        let firstChunkSeen = false;
        let firstTokenTimer = null;

        const cleanup = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          if (!stream) return;
          stream.removeListener('data', handleData);
          stream.removeListener('end', handleEnd);
          stream.removeListener('close', handleClose);
          stream.removeListener('error', handleError);
        };

        const finish = (err = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) {
            emitHttpFailureTrace(trace, prepared, body, err, {
              attempt: i + 1,
              retryable: i < maxRetry && shouldRetryStreamRequest(err, handlers),
              durationMs: Math.max(0, Date.now() - attemptStartedAt)
            });
            if (err && typeof err === 'object') streamFailureTraceEmitted.add(err);
            failModelCall(callId, err, { attempts: i + 1, requestUrl: prepared?.requestUrl });
            reject(err);
            return;
          }
          const tailEvents = flushSSEState(usageParserState);
          for (const event of tailEvents) {
            if (event?.done) streamDoneSeen = true;
            if (event?.finishReason) streamFinishReason = String(event.finishReason || '').trim();
            if (event?.usage) streamUsage = mergeUsageObjects(streamUsage, event.usage);
          }
          finishModelCall(callId, {
            response: resp,
            attempts: i + 1,
            usage: streamUsage,
            finishReason: streamFinishReason || (streamDoneSeen ? 'done' : 'stream_closed_without_terminal_event'),
            requestUrl: prepared?.requestUrl,
            request: prepared?.requestBody,
            requestHeaders: prepared?.requestHeaders
          });
          emitHttpSuccessTrace(trace, prepared, body, {
            attempt: i + 1,
            statusCode: Number(resp?.status || 0) || null,
            stream: true,
            streamDoneSeen,
            finishReason: streamFinishReason || (streamDoneSeen ? 'done' : 'stream_closed_without_terminal_event'),
            durationMs: Math.max(0, Date.now() - attemptStartedAt)
          });
          resolve();
        };

        const handleData = (chunk) => {
          const parsed = extractSSEEvents(usageParserState, chunk);
          usageParserState.buffer = parsed.state.buffer;
          for (const event of parsed.events) {
            if (event?.done) streamDoneSeen = true;
            if (event?.finishReason) streamFinishReason = String(event.finishReason || '').trim();
            if (event?.usage) streamUsage = mergeUsageObjects(streamUsage, event.usage);
          }
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          }
          handlers.__stream_started = true;
          if (onData) onData(chunk);
        };

        const handleEnd = () => {
          if (onDone) onDone();
          finish();
        };

        const handleClose = () => {
          if (settled) return;
          if (onDone) onDone();
          finish();
        };

        const handleError = (err) => {
          finish(err);
        };

        stream.on('data', handleData);
        stream.once('end', handleEnd);
        stream.once('close', handleClose);
        stream.once('error', handleError);
        firstTokenTimer = setTimeout(() => {
          if (firstChunkSeen || settled) return;
          finish(new Error(`Stream first token timeout after ${getFirstTokenTimeoutMs()}ms`));
        }, getFirstTokenTimeoutMs());
      });

      return true;
    } catch (e) {
      if (abortSignal?.aborted) {
        handlers.__abort_requested = true;
      }
      if (!e || typeof e !== 'object' || !streamFailureTraceEmitted.has(e)) {
        emitHttpFailureTrace(trace, prepared, body, e, {
          attempt: i + 1,
          retryable: i < maxRetry && shouldRetryStreamRequest(e, handlers),
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
      }
      if (callId) {
        failModelCall(callId, e, {
          attempts: i + 1,
          requestUrl: prepared?.requestUrl,
          request: prepared?.requestBody,
          requestHeaders: prepared?.requestHeaders
        });
      }
      lastErr = e;
      if (stream && typeof stream.destroy === 'function') {
        try { stream.destroy(); } catch (_) {}
      }
      if (fallbackProtocolFailed) break;
      if (i >= maxRetry || !shouldRetryStreamRequest(e, handlers)) break;

      const delayMs = getRetryDelayMs(e, i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

module.exports = {
  buildAnthropicRequestHeaders,
  buildOpenAICompatibleImageFallbackText,
  buildResponsesRequestBody,
  getAxiosOptions,
  postWithRetry,
  postStreamWithRetry,
  prepareRequest,
  mapMessagesToAnthropic,
  preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache,
  resolveAnthropicImageBlock,
  resolveOpenAICompatibleImagePart
};
