const path = require('path');
const axios = require('axios');
const config = require('../../config');
const { extractSSEEvents, flushSSEState } = require('../parser');
const { sendGroupImageMessage } = require('../qqActionService');
const {
  extractErrorCode,
  extractHttpStatus
} = require('../../utils/requestTrace');
const {
  ensureDirSync,
  readJsonFileSafe,
  writeJsonFileSafe
} = require('../createAgent/fileState');
const { detectImageExtension } = require('../createAgent/imageValidation');
const {
  extractUrlFromText,
  looksLikeHtmlDocument,
  normalizeRequestError,
  parseJsonTextSafe,
  summarizePayloadShape
} = require('../createAgent/requestUtils');
const {
  collectChatCompletionsTextFragments,
  extractImageFromChatCompletionsResponse,
  extractImageFromGenerationResponse,
  extractImageFromStreamEventPayload,
  extractImageResultFromTextBlob,
  extractStreamFailureMessage
} = require('../createAgent/responseExtractors');
const {
  buildCreateAgentAllowedUserIds,
  buildCreateAgentChatCompletionsUrl,
  buildCreateAgentChatCompletionsUrlCandidates,
  buildCreateAgentGenerationUrl,
  buildCreateAgentGenerationUrlCandidates,
  isCreateAgentUserAllowed,
  normalizeCreateAgentBaseUrl,
  normalizeCreateAgentProtocol,
  normalizeIdList,
  normalizeRequestedImageSize,
  resolveConfig
} = require('../createAgent/config');
const {
  clearRuntimeSlotsForCurrentProcess,
  consumeQuota,
  getQuotaStatus,
  isRuntimeStateStale,
  loadQuotaState,
  loadRuntimeState,
  releaseRuntimeSlot,
  tryAcquireRuntimeSlot
} = require('../createAgent/quotaRuntime');
const {
  normalizePromptText,
  buildCreateAgentPrompt
} = require('../createAgent/promptBuilder');
const {
  buildChatCompletionsImageRequestBody,
  buildImageGenerationRequestBodyVariants
} = require('../createAgent/requestBodies');
const {
  getCreateAgentRequestTrace,
  emitCreateAgentTrace,
  buildCreateAgentTracePayload,
  logCreateAgentError
} = require('../createAgent/tracing');
const {
  MAX_IMAGE_BYTES,
  downloadImageFromUrl,
  materializeGeneratedImage
} = require('../createAgent/materializeImage');
const { buildUserFacingFailureReply } = require('../createAgent/failureReply');

function validateCreateAgentPrerequisites(runtimeConfig = {}) {
  if (!runtimeConfig.apiBaseUrl) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }
  if (!runtimeConfig.apiKey) {
    throw new Error('CREATE_AGENT_API_KEY is not configured');
  }
  if (!runtimeConfig.model) {
    throw new Error('CREATE_AGENT_MODEL is not configured');
  }
}

function getCreateAgentStreamTimeoutMs(runtimeConfig = {}) {
  const configuredTimeoutMs = Math.max(1000, Number(runtimeConfig.timeoutMs || 0) || 0);
  const requestStreamTimeoutMs = Math.max(1000, Number(config.REQUEST_STREAM_TIMEOUT_MS || 0) || 0);
  const firstTokenTimeoutMs = Math.max(1000, Number(config.AI_STREAM_FIRST_TOKEN_TIMEOUT_MS || 0) || 0);
  return Math.max(configuredTimeoutMs, requestStreamTimeoutMs, firstTokenTimeoutMs, 420000);
}

function isImageGenerationParameterCompatibilityError(error = null) {
  const status = Number(error?.response?.status || 0) || 0;
  if (status !== 400) return false;

  const payload = error?.response?.data;
  const message = String(
    payload?.error?.message
    || payload?.message
    || summarizePayloadShape(payload)
    || ''
  ).trim().toLowerCase();
  const code = String(payload?.error?.code || payload?.code || '').trim().toLowerCase();
  const param = String(payload?.error?.param || payload?.param || '').trim().toLowerCase();

  if (code === 'unknown_parameter') return true;
  if (code === 'invalid_png_output_compression') return true;
  if (message.includes('unknown parameter')) return true;
  if (message.includes('unsupported parameter')) return true;
  if (message.includes('invalid parameter')) return true;
  if (message.includes('unsupported field')) return true;
  if (message.includes('compression less than 100 is not supported for png output format')) return true;
  if (message.includes('png output format') && message.includes('compression')) return true;
  if (message.includes('output compression')) return true;
  if (param.includes('style') || param.includes('background') || param.includes('output_format') || param.includes('response_format')) {
    return true;
  }
  return false;
}

async function postImageGenerationWithCompatibilityFallback(requestUrl = '', prompt = '', runtimeConfig = {}, deps = {}, options = {}) {
  const httpClient = deps.httpClient || axios;
  const requestBodies = buildImageGenerationRequestBodyVariants(prompt, runtimeConfig, options);
  let lastError = null;
  const requestTrace = getCreateAgentRequestTrace(deps, {});

  for (let index = 0; index < requestBodies.length; index += 1) {
    const requestBody = requestBodies[index];
    const startedAt = Date.now();
    emitCreateAgentTrace(requestTrace, 'create_agent_http_start', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
      attempt: index + 1,
      maxAttempts: requestBodies.length,
      stream: Boolean(options.stream),
      compatibilityVariant: index + 1
    }));
    try {
      const response = await httpClient.post(
        requestUrl,
        requestBody,
        buildImageGenerationRequestOptions(runtimeConfig, options)
      );
      emitCreateAgentTrace(requestTrace, 'create_agent_http_success', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        attempt: index + 1,
        stream: Boolean(options.stream),
        statusCode: Number(response?.status || 0) || null,
        durationMs: Math.max(0, Date.now() - startedAt)
      }));
      return {
        response,
        requestBody
      };
    } catch (error) {
      lastError = error;
      emitCreateAgentTrace(requestTrace, 'create_agent_http_failure', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        attempt: index + 1,
        stream: Boolean(options.stream),
        statusCode: extractHttpStatus(error) || null,
        finalErrorCode: extractErrorCode(error),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: String(error?.message || error || '').slice(0, 400),
        retryable: isImageGenerationParameterCompatibilityError(error) && index < requestBodies.length - 1
      }));
      if (!isImageGenerationParameterCompatibilityError(error)) {
        throw error;
      }
      if (index >= requestBodies.length - 1) {
        throw error;
      }
      emitCreateAgentTrace(requestTrace, 'create_agent_http_downgrade', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        reason: 'strip_unsupported_image_params',
        attempt: index + 1,
        stream: Boolean(options.stream),
        statusCode: extractHttpStatus(error) || null
      }));
    }
  }

  throw lastError || new Error('generation request failed');
}

function buildImageGenerationRequestOptions(runtimeConfig = {}, options = {}) {
  return {
    timeout: options.stream ? getCreateAgentStreamTimeoutMs(runtimeConfig) : runtimeConfig.timeoutMs,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    proxy: false,
    responseType: options.responseType || 'json',
    headers: {
      Authorization: `Bearer ${runtimeConfig.apiKey}`,
      'Content-Type': 'application/json',
      Accept: options.stream ? 'text/event-stream, application/json' : 'application/json, text/plain, */*',
      'User-Agent': String(
        config.MODEL_HTTP_USER_AGENT
        || config.MAIN_REPLY_USER_AGENT
        || config.HTTP_USER_AGENT
        || ''
      ).trim() || 'Mozilla/5.0'
    }
  };
}

async function requestImageGeneration(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  if (runtimeConfig.protocol === 'chat_completions') {
    return requestChatCompletionsImageGeneration(prompt, runtimeConfig, deps);
  }
  const requestUrls = buildCreateAgentGenerationUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;
  for (const requestUrl of requestUrls) {
    try {
      const { response } = await postImageGenerationWithCompatibilityFallback(
        requestUrl,
        prompt,
        runtimeConfig,
        { ...deps, httpClient },
        {}
      );
      const payload = response?.data || {};
      try {
        extractImageFromGenerationResponse(payload);
      } catch (shapeError) {
        lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(payload)}`);
        lastError.requestUrl = requestUrl;
        continue;
      }
      return {
        payload,
        requestUrl
      };
    } catch (error) {
      const normalized = new Error(normalizeRequestError(error));
      normalized.requestUrl = requestUrl;
      lastError = normalized;
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('generation response missing image data'))) {
        break;
      }
    }
  }
  throw lastError || new Error('generation response missing image data');
}

async function requestImageGenerationStream(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  if (runtimeConfig.protocol === 'chat_completions') {
    return requestChatCompletionsImageGenerationStream(prompt, runtimeConfig, deps);
  }
  const requestUrls = buildCreateAgentGenerationUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;

  for (const requestUrl of requestUrls) {
    try {
      const { response } = await postImageGenerationWithCompatibilityFallback(
        requestUrl,
        prompt,
        runtimeConfig,
        { ...deps, httpClient },
        { responseType: 'stream', stream: true }
      );

      const responseStream = response?.data;
      if (!responseStream || typeof responseStream.on !== 'function') {
        const directPayload = response?.data || {};
        const directImage = extractImageFromStreamEventPayload(directPayload);
        if (directImage) {
          return {
            imageResult: directImage,
            requestUrl,
            streamMode: false
          };
        }
        try {
          return {
            imageResult: extractImageFromGenerationResponse(directPayload),
            requestUrl,
            streamMode: false
          };
        } catch (shapeError) {
          lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(directPayload)}`);
          lastError.requestUrl = requestUrl;
          continue;
        }
      }

      const parserState = { buffer: '' };
      const rawChunks = [];
      let sawSseEvents = false;
      let finalImage = null;
      const textFragments = [];

      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          responseStream.removeListener('data', handleData);
          responseStream.removeListener('end', handleEnd);
          responseStream.removeListener('close', handleClose);
          responseStream.removeListener('error', handleError);
        };

        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };

        const consumeEvents = (events = []) => {
          for (const event of events) {
            if (!event?.json || typeof event.json !== 'object') continue;
            sawSseEvents = true;

            const streamFailure = extractStreamFailureMessage(event.json);
            if (streamFailure) {
              const error = new Error(streamFailure);
              error.requestUrl = requestUrl;
              finish(error);
              return false;
            }

            textFragments.push(...collectChatCompletionsTextFragments(event.json));

            const imageResult = extractImageFromStreamEventPayload(event.json);
            if (!imageResult) continue;

            const eventType = String(imageResult.eventType || event.json.type || '').trim().toLowerCase();
            if (eventType.endsWith('.partial_image')) {
              continue;
            }
            finalImage = imageResult;
          }
          return true;
        };

        const handleData = (chunk) => {
          rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8'));
          const parsed = extractSSEEvents(parserState, chunk);
          parserState.buffer = parsed.state.buffer;
          consumeEvents(parsed.events || []);
        };

        const finalizeTail = () => {
          const tailEvents = flushSSEState(parserState);
          consumeEvents(tailEvents || []);
        };

        const handleEnd = () => {
          finalizeTail();
          finish();
        };

        const handleClose = () => {
          if (settled) return;
          finalizeTail();
          finish();
        };

        const handleError = (error) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error || 'unknown error'));
          normalizedError.requestUrl = requestUrl;
          finish(normalizedError);
        };

        responseStream.on('data', handleData);
        responseStream.once('end', handleEnd);
        responseStream.once('close', handleClose);
        responseStream.once('error', handleError);
      });

      if (finalImage) {
        return {
          imageResult: finalImage,
          requestUrl,
          streamMode: true
        };
      }

      const aggregatedText = textFragments.join('').trim();
      if (aggregatedText) {
        const aggregatedImage = extractImageResultFromTextBlob(aggregatedText);
        if (aggregatedImage) {
          return {
            imageResult: aggregatedImage,
            requestUrl,
            streamMode: true
          };
        }
      }

      const rawText = Buffer.concat(rawChunks).toString('utf8').trim();
      if (!sawSseEvents && rawText) {
        const rawPayload = parseJsonTextSafe(rawText);
        if (rawPayload) {
          const fallbackImage = extractImageFromStreamEventPayload(rawPayload);
          if (fallbackImage) {
            return {
              imageResult: fallbackImage,
              requestUrl,
              streamMode: false
            };
          }
          try {
            return {
              imageResult: extractImageFromGenerationResponse(rawPayload),
              requestUrl,
              streamMode: false
            };
          } catch (shapeError) {
            lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(rawPayload)}`);
            lastError.requestUrl = requestUrl;
            continue;
          }
        }
      }

      lastError = new Error(
        `generation stream missing image data${rawText ? ` response_preview=${rawText.replace(/\s+/g, ' ').trim().slice(0, 400)}` : ''}`
      );
      lastError.requestUrl = requestUrl;
    } catch (error) {
      const normalized = error?.response
        ? new Error(normalizeRequestError(error))
        : (error instanceof Error ? error : new Error(String(error || 'unknown error')));
      normalized.requestUrl = error?.requestUrl || requestUrl;
      lastError = normalized;
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('generation stream missing image data') || lower.includes('generation response missing image data'))) {
        break;
      }
    }
  }

  throw lastError || new Error('generation stream missing image data');
}

async function requestChatCompletionsImageGeneration(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  const requestUrls = buildCreateAgentChatCompletionsUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;
  const requestTrace = getCreateAgentRequestTrace(deps, {});

  for (const requestUrl of requestUrls) {
    const startedAt = Date.now();
    emitCreateAgentTrace(requestTrace, 'create_agent_http_start', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
      stream: false,
      backend: 'chat_completions'
    }));
    try {
      const response = await httpClient.post(
        requestUrl,
        buildChatCompletionsImageRequestBody(prompt, runtimeConfig, {}),
        buildImageGenerationRequestOptions(runtimeConfig, {})
      );
      emitCreateAgentTrace(requestTrace, 'create_agent_http_success', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        stream: false,
        backend: 'chat_completions',
        statusCode: Number(response?.status || 0) || null,
        durationMs: Math.max(0, Date.now() - startedAt)
      }));
      const payload = response?.data || {};
      if (typeof payload === 'string' && looksLikeHtmlDocument(payload)) {
        lastError = new Error(`chat completions endpoint returned html response_preview=${summarizePayloadShape(payload)}`);
        lastError.requestUrl = requestUrl;
        continue;
      }
      try {
        extractImageFromChatCompletionsResponse(payload);
      } catch (shapeError) {
        lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(payload)}`);
        lastError.requestUrl = requestUrl;
        continue;
      }
      return {
        payload,
        requestUrl
      };
    } catch (error) {
      const normalized = new Error(normalizeRequestError(error));
      normalized.requestUrl = requestUrl;
      lastError = normalized;
      emitCreateAgentTrace(requestTrace, 'create_agent_http_failure', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        stream: false,
        backend: 'chat_completions',
        statusCode: extractHttpStatus(error) || null,
        finalErrorCode: extractErrorCode(error),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: String(normalized.message || error?.message || error || '').slice(0, 400)
      }));
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('chat completions response missing image data'))) {
        break;
      }
    }
  }

  throw lastError || new Error('chat completions response missing image data');
}

async function requestChatCompletionsImageGenerationStream(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  const requestUrls = buildCreateAgentChatCompletionsUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;
  const requestTrace = getCreateAgentRequestTrace(deps, {});

  for (const requestUrl of requestUrls) {
    const startedAt = Date.now();
    emitCreateAgentTrace(requestTrace, 'create_agent_http_start', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
      stream: true,
      backend: 'chat_completions'
    }));
    try {
      const response = await httpClient.post(
        requestUrl,
        buildChatCompletionsImageRequestBody(prompt, runtimeConfig, { stream: true }),
        buildImageGenerationRequestOptions(runtimeConfig, { responseType: 'stream', stream: true })
      );
      emitCreateAgentTrace(requestTrace, 'create_agent_http_success', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        stream: true,
        backend: 'chat_completions',
        statusCode: Number(response?.status || 0) || null,
        durationMs: Math.max(0, Date.now() - startedAt)
      }));

      const responseStream = response?.data;
      if (!responseStream || typeof responseStream.on !== 'function') {
        const directPayload = response?.data || {};
        if (typeof directPayload === 'string' && looksLikeHtmlDocument(directPayload)) {
          lastError = new Error(`chat completions endpoint returned html response_preview=${summarizePayloadShape(directPayload)}`);
          lastError.requestUrl = requestUrl;
          continue;
        }
        const directImage = extractImageFromStreamEventPayload(directPayload);
        if (directImage) {
          return {
            imageResult: directImage,
            requestUrl,
            streamMode: false
          };
        }
        try {
          return {
            imageResult: extractImageFromChatCompletionsResponse(directPayload),
            requestUrl,
            streamMode: false
          };
        } catch (shapeError) {
          lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(directPayload)}`);
          lastError.requestUrl = requestUrl;
          continue;
        }
      }

      const parserState = { buffer: '' };
      const rawChunks = [];
      let sawSseEvents = false;
      let finalImage = null;
      const textFragments = [];

      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          responseStream.removeListener('data', handleData);
          responseStream.removeListener('end', handleEnd);
          responseStream.removeListener('close', handleClose);
          responseStream.removeListener('error', handleError);
        };

        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };

        const consumeEvents = (events = []) => {
          for (const event of events) {
            if (!event?.json || typeof event.json !== 'object') continue;
            sawSseEvents = true;

            const streamFailure = extractStreamFailureMessage(event.json);
            if (streamFailure) {
              const error = new Error(streamFailure);
              error.requestUrl = requestUrl;
              finish(error);
              return false;
            }

            textFragments.push(...collectChatCompletionsTextFragments(event.json));

            const imageResult = extractImageFromStreamEventPayload(event.json);
            if (!imageResult) continue;

            const eventType = String(imageResult.eventType || event.json.type || '').trim().toLowerCase();
            if (eventType.endsWith('.partial_image')) continue;
            finalImage = imageResult;
          }
          return true;
        };

        const handleData = (chunk) => {
          rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8'));
          const parsed = extractSSEEvents(parserState, chunk);
          parserState.buffer = parsed.state.buffer;
          consumeEvents(parsed.events || []);
        };

        const finalizeTail = () => {
          const tailEvents = flushSSEState(parserState);
          consumeEvents(tailEvents || []);
        };

        const handleEnd = () => {
          finalizeTail();
          finish();
        };

        const handleClose = () => {
          if (settled) return;
          finalizeTail();
          finish();
        };

        const handleError = (error) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error || 'unknown error'));
          normalizedError.requestUrl = requestUrl;
          finish(normalizedError);
        };

        responseStream.on('data', handleData);
        responseStream.once('end', handleEnd);
        responseStream.once('close', handleClose);
        responseStream.once('error', handleError);
      });

      if (finalImage) {
        return {
          imageResult: finalImage,
          requestUrl,
          streamMode: true
        };
      }

      const aggregatedText = textFragments.join('').trim();
      if (aggregatedText) {
        const aggregatedImage = extractImageResultFromTextBlob(aggregatedText);
        if (aggregatedImage) {
          return {
            imageResult: aggregatedImage,
            requestUrl,
            streamMode: true
          };
        }
      }

      const rawText = Buffer.concat(rawChunks).toString('utf8').trim();
      if (!sawSseEvents && rawText) {
        if (looksLikeHtmlDocument(rawText)) {
          lastError = new Error(`chat completions endpoint returned html response_preview=${summarizePayloadShape(rawText)}`);
          lastError.requestUrl = requestUrl;
          continue;
        }
        const rawPayload = parseJsonTextSafe(rawText);
        if (rawPayload) {
          const fallbackImage = extractImageFromStreamEventPayload(rawPayload);
          if (fallbackImage) {
            return {
              imageResult: fallbackImage,
              requestUrl,
              streamMode: false
            };
          }
          try {
            return {
              imageResult: extractImageFromChatCompletionsResponse(rawPayload),
              requestUrl,
              streamMode: false
            };
          } catch (shapeError) {
            lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(rawPayload)}`);
            lastError.requestUrl = requestUrl;
            continue;
          }
        }
      }

      lastError = new Error(
        `chat completions stream missing image data${rawText ? ` response_preview=${rawText.replace(/\s+/g, ' ').trim().slice(0, 400)}` : ''}`
      );
      lastError.requestUrl = requestUrl;
    } catch (error) {
      const normalized = error?.response
        ? new Error(normalizeRequestError(error))
        : (error instanceof Error ? error : new Error(String(error || 'unknown error')));
      normalized.requestUrl = error?.requestUrl || requestUrl;
      lastError = normalized;
      emitCreateAgentTrace(requestTrace, 'create_agent_http_failure', buildCreateAgentTracePayload(runtimeConfig, requestUrl, {
        stream: true,
        backend: 'chat_completions',
        statusCode: extractHttpStatus(error) || null,
        finalErrorCode: extractErrorCode(error),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: String(normalized.message || error?.message || error || '').slice(0, 400)
      }));
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('chat completions stream missing image data') || lower.includes('chat completions response missing image data'))) {
        break;
      }
    }
  }

  throw lastError || new Error('chat completions stream missing image data');
}

async function generateImageWithOpenAICompatibleApi(prompt = '', runtimeConfig = {}, deps = {}) {
  let streamError = null;
  try {
    const streamedResult = await requestImageGenerationStream(prompt, runtimeConfig, deps);
    try {
      return await materializeGeneratedImage(streamedResult?.imageResult, prompt, runtimeConfig, deps);
    } catch (error) {
      error.requestUrl = error.requestUrl || streamedResult?.requestUrl || '';
      streamError = error;
    }
  } catch (error) {
    streamError = error;
  }

  let generationError = null;
  try {
    const generationResult = await requestImageGeneration(prompt, runtimeConfig, deps);
    const payload = generationResult?.payload || {};
    const extractedImage = runtimeConfig.protocol === 'chat_completions'
      ? extractImageFromChatCompletionsResponse(payload)
      : extractImageFromGenerationResponse(payload);
    try {
      return await materializeGeneratedImage(extractedImage, prompt, runtimeConfig, deps);
    } catch (error) {
      error.requestUrl = error.requestUrl || generationResult?.requestUrl || '';
      generationError = error;
    }
  } catch (error) {
    generationError = generationError || error;
  }

  const shouldTryUrlFallback = runtimeConfig.protocol === 'chat_completions'
    && String(runtimeConfig.responseFormat || '').trim().toLowerCase() !== 'url'
    && (() => {
      const combinedMessage = String(generationError?.message || streamError?.message || '').toLowerCase();
      return combinedMessage.includes('image buffer invalid or truncated')
        || combinedMessage.includes('image buffer empty')
        || combinedMessage.includes('chat completions response missing image data')
        || combinedMessage.includes('chat completions stream missing image data')
        || combinedMessage.includes('generation response missing image data')
        || combinedMessage.includes('generation stream missing image data');
    })();

  if (shouldTryUrlFallback) {
    const urlFallbackConfig = {
      ...runtimeConfig,
      responseFormat: 'url'
    };
    emitCreateAgentTrace(getCreateAgentRequestTrace(deps, {}), 'create_agent_http_downgrade', buildCreateAgentTracePayload(runtimeConfig, '', {
      reason: 'url_response_format_fallback',
      stream: false
    }));
    try {
      const fallbackResult = await requestImageGeneration(prompt, urlFallbackConfig, deps);
      const payload = fallbackResult?.payload || {};
      const extractedImage = extractImageFromChatCompletionsResponse(payload);
      return await materializeGeneratedImage(extractedImage, prompt, urlFallbackConfig, deps);
    } catch (error) {
      if (generationError && !String(error.message || '').includes('generation_attempt=')) {
        error.message = `${String(error.message || '').trim()} generation_attempt=${String(generationError.message || generationError).trim()}`.trim();
      }
      if (streamError && !String(error.message || '').includes('stream_attempt=')) {
        error.message = `${String(error.message || '').trim()} stream_attempt=${String(streamError.message || streamError).trim()}`.trim();
      }
      throw error;
    }
  }

  const finalError = generationError || streamError || new Error('generation response missing image data');
  if (streamError && finalError !== streamError && !String(finalError.message || '').includes('stream_attempt=')) {
    finalError.message = `${String(finalError.message || '').trim()} stream_attempt=${String(streamError.message || streamError).trim()}`.trim();
  }
  throw finalError;
}

async function executeCreateCommand(context = {}, deps = {}) {
  const runtimeConfig = resolveConfig(deps.config);
  const prompt = normalizePromptText(context.prompt || context.payload || '');
  const chatType = String(context.chatType || '').trim().toLowerCase();
  const groupId = String(context.groupId || '').trim();
  const senderId = String(context.senderId || context.userId || '').trim();
  const requestTrace = getCreateAgentRequestTrace(deps, context);
  const commandStartedAt = Date.now();
  const emitCommandTrace = (stage = '', payload = {}) => emitCreateAgentTrace(requestTrace, stage, {
    userId: senderId,
    groupId,
    chatType,
    model: String(runtimeConfig.model || '').trim(),
    provider: 'openai_compatible',
    protocol: String(runtimeConfig.protocol || 'images').trim(),
    durationMs: Math.max(0, Date.now() - commandStartedAt),
    ...payload
  });
  emitCommandTrace('create_agent_runtime_start');

  ensureDirSync(path.dirname(runtimeConfig.quotaFile));
  ensureDirSync(path.dirname(runtimeConfig.runtimeFile));
  ensureDirSync(path.dirname(runtimeConfig.errorLogFile));
  ensureDirSync(runtimeConfig.outputDir);

  if (!runtimeConfig.enabled) {
    emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'disabled' });
    return { ok: false, replyText: '生图 worker 未开启', code: 'disabled' };
  }
  if (!prompt) {
    emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'empty_prompt' });
    return { ok: false, replyText: '用法: /create <prompt>', code: 'empty_prompt' };
  }
  if (runtimeConfig.groupOnly && chatType === 'private') {
    emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'group_only' });
    return { ok: false, replyText: '仅群聊可用', code: 'group_only' };
  }
  if (!groupId) {
    emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'missing_group' });
    return { ok: false, replyText: '仅群聊可用', code: 'missing_group' };
  }

  const runtimeSlot = tryAcquireRuntimeSlot(runtimeConfig);
  if (!runtimeSlot.ok) {
    emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'busy' });
    return { ok: false, replyText: '生图 worker 正忙，请稍后重试', code: 'busy' };
  }

  let quotaConsumed = false;
  try {
    const quotaStatus = getQuotaStatus(runtimeConfig);
    if (quotaStatus.remaining <= 0) {
      emitCommandTrace('create_agent_runtime_failure', { finalErrorCode: 'quota_exceeded' });
      return { ok: false, replyText: '今日生图额度已用完', code: 'quota_exceeded' };
    }

    validateCreateAgentPrerequisites(runtimeConfig);
    consumeQuota(runtimeConfig);
    quotaConsumed = true;

    const normalizedPrompt = buildCreateAgentPrompt(prompt, {
      imageSize: runtimeConfig.imageSize
    });
    const materialized = await (deps.generateImage || generateImageWithOpenAICompatibleApi)(
      normalizedPrompt,
      runtimeConfig,
      { ...deps, requestTrace }
    );
    await (deps.sendGroupImageMessage || sendGroupImageMessage)(groupId, materialized.buffer, deps.sendOptions || {});
    emitCommandTrace('create_agent_runtime_success', {
      imagePath: String(materialized.filePath || '').trim()
    });

    return {
      ok: true,
      code: 'sent',
      imagePath: materialized.filePath
    };
  } catch (error) {
    emitCommandTrace('create_agent_runtime_failure', {
      finalErrorCode: extractErrorCode(error) || 'failed',
      requestUrl: String(error?.requestUrl || '').trim(),
      error: String(error?.message || error || '').slice(0, 400)
    });
    logCreateAgentError(runtimeConfig, {
      ...context,
      requestUrl: String(error?.requestUrl || '').trim(),
      responsePreview: String(error?.message || '').includes('response_preview=')
        ? String(error.message).split('response_preview=').slice(1).join('response_preview=').trim()
        : ''
    }, error);
    return {
      ok: false,
      replyText: quotaConsumed
        ? buildUserFacingFailureReply(error, runtimeConfig)
        : buildUserFacingFailureReply(error, runtimeConfig),
      code: 'failed',
      error: error?.message || String(error || 'unknown error')
    };
  } finally {
    releaseRuntimeSlot(runtimeConfig);
  }
}

module.exports = {
  buildCreateAgentChatCompletionsUrl,
  buildCreateAgentChatCompletionsUrlCandidates,
  buildCreateAgentGenerationUrl,
  buildCreateAgentGenerationUrlCandidates,
  buildCreateAgentAllowedUserIds,
  buildCreateAgentPrompt,
  buildUserFacingFailureReply,
  buildImageGenerationRequestBodyVariants,
  consumeQuota,
  detectImageExtension,
  downloadImageFromUrl,
  executeCreateCommand,
  extractImageFromChatCompletionsResponse,
  extractImageFromGenerationResponse,
  extractImageFromStreamEventPayload,
  generateImageWithOpenAICompatibleApi,
  getQuotaStatus,
  loadQuotaState,
  loadRuntimeState,
  isRuntimeStateStale,
  isCreateAgentUserAllowed,
  isImageGenerationParameterCompatibilityError,
  normalizeCreateAgentBaseUrl,
  normalizeCreateAgentProtocol,
  normalizeIdList,
  normalizeRequestedImageSize,
  normalizeRequestError,
  postImageGenerationWithCompatibilityFallback,
  readJsonFileSafe,
  requestImageGeneration,
  requestImageGenerationStream,
  resolveConfig,
  tryAcquireRuntimeSlot,
  releaseRuntimeSlot,
  clearRuntimeSlotsForCurrentProcess,
  writeJsonFileSafe
};
