const {
  createModelRouteTracePatch,
  extractErrorCode,
  extractHttpStatus,
  failModelCall,
  finishModelCall,
  normalizeText,
  startModelCall,
  buildModelRouteDiagnostics
} = require('./runtime-core.chunk');
const { postModelHttp } = require('./model-post.chunk');
const {
  buildPinnedLookup,
  getAxiosOptions,
  getRequestTimeoutMs,
  getRetryDelayMs,
  getRetryTimeoutMs,
  prepareRequest,
  shouldRetry,
  validatePreparedEndpoint
} = require('./prepare.chunk');
const {
  anthropicRequestUsesPromptCaching,
  stripAnthropicAutomaticPromptCaching,
  stripAnthropicPromptCaching
} = require('./runtime-core.chunk');
const {
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
  buildChatCompletionsFallbackUrl,
  isOpenAICompatiblePromptCacheSchemaError,
  isOpenAIPromptCacheRetentionSchemaError,
  markResponsesProtocolFallbackAttempted,
  requestUsesOpenAICompatiblePromptCaching,
  requestUsesOpenAIPromptCacheRetention,
  shouldFallbackResponsesProtocol,
  stripOpenAICompatiblePromptCaching,
  stripOpenAIPromptCacheRetentionFromRequest
} = require('./openai-compatible.chunk');
const { buildRequestCacheTrace } = require('./prepare.chunk');
const {
  assertCanCall,
  recordSuccess
} = require('../../../utils/normalUserModelDailyQuota');

async function postQuotaCheckedModelHttp(trace, url, requestBody, axiosOptions) {
  await assertCanCall(trace);
  return postModelHttp(url, requestBody, axiosOptions);
}

async function recordQuotaSuccess(trace) {
  try {
    await recordSuccess(trace);
  } catch (error) {
    console.error('[normal-user-model-quota] record success failed:', error?.message || error);
  }
}

/**
 * POST request with retry + exponential backoff.
 */
async function postWithRetry(url, body, retries = 1, specificKey = null) {
  let lastErr;
  const maxRetry = Math.max(0, Number(retries) || 0);
  const trace = body && typeof body === 'object' && body.__trace && typeof body.__trace === 'object'
    ? body.__trace
    : {};
  const requestedTimeoutMs = body && typeof body === 'object'
    ? Number(body.__timeoutMs)
    : NaN;
  const abortSignal = body && typeof body === 'object' && body.__abortSignal
    ? body.__abortSignal
    : null;

  for (let i = 0; i <= maxRetry; i++) {
    let callId = '';
    let prepared = null;
    let pinnedLookup = null;
    let timeoutMs = getRequestTimeoutMs();
    const attemptStartedAt = Date.now();
    try {
      const timeoutBase = Number.isFinite(requestedTimeoutMs)
        ? Math.max(1000, Math.floor(requestedTimeoutMs))
        : getRequestTimeoutMs();
      const timeoutCap = Number.isFinite(requestedTimeoutMs)
        ? Math.max(timeoutBase, timeoutBase + (15000 * Math.max(0, maxRetry)))
        : 180000;
      timeoutMs = getRetryTimeoutMs(timeoutBase, i, 15000, timeoutCap);
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
        stream: Boolean(prepared.requestBody?.stream || body?.stream),
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
      const response = await postQuotaCheckedModelHttp(
        trace,
        prepared.requestUrl,
        prepared.requestBody,
        getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
      );
      emitHttpTrace(trace, 'http_client_success', {
        stage: 'http_client_success',
        attempt: i + 1,
        provider: prepared.provider,
        model: prepared.requestBody?.model || body?.model || '',
        requestUrl: prepared.requestUrl,
        statusCode: Number(response?.status || 0) || null,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
        fallbackActive: trace.mainFallbackActive === true
      });
      Object.defineProperty(response, '__modelCallId', {
        value: callId,
        enumerable: false,
        configurable: true
      });
      finishModelCall(callId, {
        response,
        attempts: i + 1,
        requestUrl: prepared.requestUrl,
        request: prepared.requestBody,
        requestHeaders: prepared.requestHeaders
      });
      await recordQuotaSuccess(trace);
      return response;
    } catch (e) {
      emitHttpTrace(trace, 'http_client_failure', {
        stage: 'http_client_failure',
        attempt: i + 1,
        provider: prepared?.provider,
        model: prepared?.requestBody?.model || body?.model || '',
        requestUrl: prepared?.requestUrl,
        statusCode: extractHttpStatus(e) || null,
        finalErrorCode: extractErrorCode(e),
        error: normalizeText(e?.message || e).slice(0, 400),
        retryable: i < maxRetry && shouldRetry(e),
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        fallbackActive: trace.mainFallbackActive === true
      });
      if (callId && shouldFallbackResponsesProtocol(prepared, body, e)) {
        const fallbackUrl = buildChatCompletionsFallbackUrl(prepared.requestUrl);
        const fallbackBody = markResponsesProtocolFallbackAttempted(body);
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'fallback_chat_completions_protocol',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          fallbackRequestUrl: fallbackUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const response = await postWithRetry(fallbackUrl, fallbackBody, Math.max(0, maxRetry - i), specificKey);
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: fallbackUrl,
            request: fallbackBody,
            requestHeaders: prepared.requestHeaders
          });
          return response;
        } catch (fallbackError) {
          emitHttpFailureTrace(trace, { ...prepared, requestUrl: fallbackUrl, requestBody: fallbackBody }, body, fallbackError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(fallbackError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'fallback_chat_completions_protocol'
          });
          if (callId) {
            failModelCall(callId, fallbackError, {
              attempts: i + 1,
              requestUrl: fallbackUrl,
              request: fallbackBody,
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = fallbackError;
          break;
        }
      }
      if (callId && requestUsesReasoning(prepared?.requestBody) && isReasoningSchemaError(e)) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_reasoning_fields',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripReasoningFields(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_reasoning_fields'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutReasoningError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripReasoningFields(prepared.requestBody) }, body, retryWithoutReasoningError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutReasoningError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_reasoning_fields'
          });
          if (callId) {
            failModelCall(callId, retryWithoutReasoningError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripReasoningFields(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutReasoningError;
          if (i >= maxRetry || !shouldRetry(retryWithoutReasoningError)) break;
          const delayMs = getRetryDelayMs(retryWithoutReasoningError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (callId && requestUsesExtendedSampling(prepared?.requestBody) && isExtendedSamplingSchemaError(e)) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_extended_sampling_fields',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripExtendedSamplingFields(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_extended_sampling_fields'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutSamplingError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripExtendedSamplingFields(prepared.requestBody) }, body, retryWithoutSamplingError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutSamplingError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_extended_sampling_fields'
          });
          if (callId) {
            failModelCall(callId, retryWithoutSamplingError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripExtendedSamplingFields(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutSamplingError;
          if (i >= maxRetry || !shouldRetry(retryWithoutSamplingError)) break;
          const delayMs = getRetryDelayMs(retryWithoutSamplingError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (callId && requestUsesTemperature(prepared?.requestBody) && isTemperatureSchemaError(e)) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_temperature_field',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripTemperatureField(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_temperature_field'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutTemperatureError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripTemperatureField(prepared.requestBody) }, body, retryWithoutTemperatureError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutTemperatureError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_temperature_field'
          });
          if (callId) {
            failModelCall(callId, retryWithoutTemperatureError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripTemperatureField(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutTemperatureError;
          if (i >= maxRetry || !shouldRetry(retryWithoutTemperatureError)) break;
          const delayMs = getRetryDelayMs(retryWithoutTemperatureError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && requestUsesTemperature(prepared?.requestBody)
        && requestUsesTopP(prepared?.requestBody)
        && isTemperatureTopPConflictError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_top_p_field',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripTopPRequestField(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_top_p_field'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutTopPError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripTopPRequestField(prepared.requestBody) }, body, retryWithoutTopPError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutTopPError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_top_p_field'
          });
          if (callId) {
            failModelCall(callId, retryWithoutTopPError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripTopPRequestField(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutTopPError;
          if (i >= maxRetry || !shouldRetry(retryWithoutTopPError)) break;
          const delayMs = getRetryDelayMs(retryWithoutTopPError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'openai_compatible'
        && requestUsesOpenAIPromptCacheRetention(prepared.requestBody)
        && isOpenAIPromptCacheRetentionSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_openai_prompt_cache_retention',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache_retention'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutRetentionError) {
          const strippedRetentionRequestBody = stripOpenAIPromptCacheRetentionFromRequest(prepared.requestBody);
          if (
            requestUsesOpenAICompatiblePromptCaching(strippedRetentionRequestBody)
            && isOpenAICompatiblePromptCacheSchemaError(retryWithoutRetentionError)
          ) {
            emitHttpTrace(trace, 'http_client_request_downgrade', {
              stage: 'http_client_request_downgrade',
              reason: 'strip_openai_prompt_cache',
              provider: prepared?.provider,
              model: prepared?.requestBody?.model || body?.model || '',
              requestUrl: prepared?.requestUrl,
              statusCode: extractHttpStatus(retryWithoutRetentionError) || null
            });
            try {
              const strippedCacheRequestBody = stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody);
              const response = await postQuotaCheckedModelHttp(
                trace,
                prepared.requestUrl,
                strippedCacheRequestBody,
                getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
              );
              emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedCacheRequestBody }, body, {
                attempt: i + 1,
                statusCode: Number(response?.status || 0) || null,
                durationMs: Math.max(0, Date.now() - attemptStartedAt),
                transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
                downgraded: true,
                downgradeReason: 'strip_openai_prompt_cache'
              });
              finishModelCall(callId, {
                response,
                attempts: i + 1,
                requestUrl: prepared.requestUrl,
                request: strippedCacheRequestBody,
                requestHeaders: prepared.requestHeaders
              });
              await recordQuotaSuccess(trace);
              return response;
            } catch (retryWithoutCacheError) {
              emitHttpFailureTrace(trace, { ...prepared, requestBody: stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody) }, body, retryWithoutCacheError, {
                attempt: i + 1,
                retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
                durationMs: Math.max(0, Date.now() - attemptStartedAt),
                downgraded: true,
                downgradeReason: 'strip_openai_prompt_cache'
              });
              if (callId) {
                failModelCall(callId, retryWithoutCacheError, {
                  attempts: i + 1,
                  requestUrl: prepared.requestUrl,
                  request: stripOpenAICompatiblePromptCaching(strippedRetentionRequestBody),
                  requestHeaders: prepared.requestHeaders
                });
              }
              lastErr = retryWithoutCacheError;
              if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
              const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
          }
          if (callId) {
            emitHttpFailureTrace(trace, { ...prepared, requestBody: strippedRetentionRequestBody }, body, retryWithoutRetentionError, {
              attempt: i + 1,
              retryable: i < maxRetry && shouldRetry(retryWithoutRetentionError),
              durationMs: Math.max(0, Date.now() - attemptStartedAt),
              downgraded: true,
              downgradeReason: 'strip_openai_prompt_cache_retention'
            });
            failModelCall(callId, retryWithoutRetentionError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: strippedRetentionRequestBody,
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutRetentionError;
          if (i >= maxRetry || !shouldRetry(retryWithoutRetentionError)) break;
          const delayMs = getRetryDelayMs(retryWithoutRetentionError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'openai_compatible'
        && requestUsesOpenAICompatiblePromptCaching(prepared.requestBody)
        && isOpenAICompatiblePromptCacheSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_openai_prompt_cache',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const strippedRequestBody = stripOpenAICompatiblePromptCaching(prepared.requestBody);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            strippedRequestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, prepared.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: strippedRequestBody }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: strippedRequestBody,
            requestHeaders: prepared.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutCacheError) {
          emitHttpFailureTrace(trace, { ...prepared, requestBody: stripOpenAICompatiblePromptCaching(prepared.requestBody) }, body, retryWithoutCacheError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_openai_prompt_cache'
          });
          if (callId) {
            failModelCall(callId, retryWithoutCacheError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: stripOpenAICompatiblePromptCaching(prepared.requestBody),
              requestHeaders: prepared.requestHeaders
            });
          }
          lastErr = retryWithoutCacheError;
          if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
          const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      if (
        callId
        && prepared?.provider === 'anthropic'
        && anthropicRequestUsesPromptCaching(prepared.requestBody)
        && isAnthropicPromptCacheSchemaError(e)
      ) {
        emitHttpTrace(trace, 'http_client_request_downgrade', {
          stage: 'http_client_request_downgrade',
          reason: 'strip_anthropic_prompt_cache',
          provider: prepared?.provider,
          model: prepared?.requestBody?.model || body?.model || '',
          requestUrl: prepared?.requestUrl,
          statusCode: extractHttpStatus(e) || null,
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        try {
          const automaticDowngrade = stripAnthropicAutomaticPromptCaching(prepared.requestBody, prepared.requestHeaders);
          try {
            const response = await postQuotaCheckedModelHttp(
              trace,
              prepared.requestUrl,
              automaticDowngrade.requestBody,
              getAxiosOptions(prepared.provider, specificKey, timeoutMs, automaticDowngrade.requestHeaders, abortSignal, pinnedLookup)
            );
            emitHttpSuccessTrace(trace, { ...prepared, requestBody: automaticDowngrade.requestBody, requestHeaders: automaticDowngrade.requestHeaders }, body, {
              attempt: i + 1,
              statusCode: Number(response?.status || 0) || null,
              durationMs: Math.max(0, Date.now() - attemptStartedAt),
              transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
              downgraded: true,
              downgradeReason: 'strip_anthropic_automatic_prompt_cache'
            });
            finishModelCall(callId, {
              response,
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: automaticDowngrade.requestBody,
              requestHeaders: automaticDowngrade.requestHeaders
            });
            await recordQuotaSuccess(trace);
            return response;
          } catch (automaticDowngradeError) {
            if (!anthropicRequestUsesPromptCaching(automaticDowngrade.requestBody) || !isAnthropicPromptCacheSchemaError(automaticDowngradeError)) {
              throw automaticDowngradeError;
            }
          }

          const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
          const response = await postQuotaCheckedModelHttp(
            trace,
            prepared.requestUrl,
            downgraded.requestBody,
            getAxiosOptions(prepared.provider, specificKey, timeoutMs, downgraded.requestHeaders, abortSignal, pinnedLookup)
          );
          emitHttpSuccessTrace(trace, { ...prepared, requestBody: downgraded.requestBody, requestHeaders: downgraded.requestHeaders }, body, {
            attempt: i + 1,
            statusCode: Number(response?.status || 0) || null,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            transport: response?.__modelHttpTransport || response?.request?.transport || 'axios',
            downgraded: true,
            downgradeReason: 'strip_anthropic_prompt_cache'
          });
          finishModelCall(callId, {
            response,
            attempts: i + 1,
            requestUrl: prepared.requestUrl,
            request: downgraded.requestBody,
            requestHeaders: downgraded.requestHeaders
          });
          await recordQuotaSuccess(trace);
          return response;
        } catch (retryWithoutCacheError) {
          const downgraded = stripAnthropicPromptCaching(prepared.requestBody, prepared.requestHeaders);
          emitHttpFailureTrace(trace, { ...prepared, requestBody: downgraded.requestBody, requestHeaders: downgraded.requestHeaders }, body, retryWithoutCacheError, {
            attempt: i + 1,
            retryable: i < maxRetry && shouldRetry(retryWithoutCacheError),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            downgraded: true,
            downgradeReason: 'strip_anthropic_prompt_cache'
          });
          if (callId) {
            failModelCall(callId, retryWithoutCacheError, {
              attempts: i + 1,
              requestUrl: prepared.requestUrl,
              request: downgraded.requestBody,
              requestHeaders: downgraded.requestHeaders
            });
          }
          lastErr = retryWithoutCacheError;
          if (i >= maxRetry || !shouldRetry(retryWithoutCacheError)) break;
          const delayMs = getRetryDelayMs(retryWithoutCacheError, i);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
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
      if (i >= maxRetry || !shouldRetry(e)) break;

      const delayMs = getRetryDelayMs(e, i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

module.exports = {
  postWithRetry
};
