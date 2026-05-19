const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { extractSSEEvents, flushSSEState } = require('./parser');
const { sendGroupImageMessage } = require('./qqActionService');
const {
  appendRequestTraceEvent,
  extractErrorCode,
  extractHttpStatus,
  nextTracePhase,
  normalizeRequestTrace
} = require('../utils/requestTrace');
const {
  appendTextFileSafe,
  ensureDirSync,
  readJsonFileSafe,
  writeJsonFileSafe
} = require('./createAgent/fileState');
const {
  detectImageExtension,
  normalizeBase64ImageData,
  validateImageBuffer
} = require('./createAgent/imageValidation');
const {
  extractUrlFromText,
  looksLikeHtmlDocument,
  normalizeRequestError,
  parseJsonTextSafe,
  summarizePayloadShape
} = require('./createAgent/requestUtils');
const {
  collectChatCompletionsTextFragments,
  extractImageFromChatCompletionsResponse,
  extractImageFromGenerationResponse,
  extractImageFromStreamEventPayload,
  extractImageResultFromTextBlob,
  extractStreamFailureMessage
} = require('./createAgent/responseExtractors');
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
} = require('./createAgent/config');
const {
  clearRuntimeSlotsForCurrentProcess,
  consumeQuota,
  getQuotaStatus,
  isRuntimeStateStale,
  loadQuotaState,
  loadRuntimeState,
  releaseRuntimeSlot,
  tryAcquireRuntimeSlot
} = require('./createAgent/quotaRuntime');

const DEFAULT_IMAGE_EXTENSION = '.png';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CREATE_AGENT_STREAM_PARTIAL_IMAGES = 1;

function normalizePromptText(prompt = '') {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildResolutionQualityClause(imageSize = '') {
  const normalizedSize = normalizeRequestedImageSize(imageSize);
  const sizeMatch = normalizedSize.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!sizeMatch) {
    return 'Target native high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }

  const width = Number(sizeMatch[1] || 0);
  const height = Number(sizeMatch[2] || 0);
  const longestEdge = Math.max(width, height);
  if (longestEdge >= 3840) {
    return 'Target true 4K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 2048) {
    return 'Target true 2K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 1536) {
    return 'Target high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  return 'Target clean high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
}

function buildCreateAgentPrompt(rawPrompt = '', options = {}) {
  const prompt = normalizePromptText(rawPrompt);
  if (!prompt) return '';

  const effectiveSize = normalizeRequestedImageSize(options.imageSize || '');
  const hasSizeHint = /(1024|1536|2048|4096|1k|2k|4k|1080p|high[- ]?res|high resolution|ultra)/i.test(prompt);
  const hasPhotoHint = /(照片|摄影|真实|写实|photoreal|photo[- ]?real|iphone photo|realistic)/i.test(prompt);
  const hasNoTextHint = /(不要文字|无文字|no text|without text|不要水印|no watermark)/i.test(prompt);
  const hasCompositionHint = /(竖图|横图|方图|portrait|landscape|square|9:16|16:9|手机截图|海报|poster|screenshot)/i.test(prompt);
  const hasSharpnessHint = /(清晰|锐利|锐度|sharp|crisp|high detail|fine detail|ultra detailed|detailed skin|clean lineart|clean linework)/i.test(prompt);
  const hasAntiBlurHint = /(不要模糊|避免模糊|no blur|avoid blur|sharp focus|in focus|clear edges|anti[- ]blur)/i.test(prompt);

  const clauses = [prompt];
  if (!hasPhotoHint) {
    clauses.push('Use clean composition and natural lighting with coherent details.');
  }
  if (!hasSharpnessHint) {
    clauses.push('Prioritize crisp focus, sharp edges, clean linework, high local contrast, and dense fine details.');
  }
  if (!hasAntiBlurHint) {
    clauses.push('Avoid blur, softness, haze, washed-out textures, smeared details, and low-detail backgrounds.');
  }
  clauses.push(buildResolutionQualityClause(effectiveSize));
  clauses.push('Preserve facial features, eyes, hands, hair strands, clothing textures, object edges, and small foreground details without mushiness.');
  if (!hasNoTextHint) {
    clauses.push('No text, watermark, UI, screenshot, or logo.');
  }
  if (!hasCompositionHint) {
    clauses.push('Render it as a polished single-image composition.');
  }
  if (!hasSizeHint) {
    clauses.push(`Prefer a polished single-image composition suitable for a ${effectiveSize === 'auto' ? 'native high-quality image output' : effectiveSize + ' output'}.`);
  }
  return clauses.join(' ');
}

function buildOutputBasename(prompt = '') {
  const datePart = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const normalized = normalizePromptText(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${datePart}-${normalized || 'create'}-${suffix}`;
}

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

function buildImageOutputPath(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  const extension = detectImageExtension(buffer, DEFAULT_IMAGE_EXTENSION, mimeType);
  return path.join(runtimeConfig.outputDir, `${buildOutputBasename(prompt)}${extension}`);
}

function buildImageGenerationRequestBody(prompt = '', runtimeConfig = {}, options = {}) {
  const body = {
    model: runtimeConfig.model,
    prompt,
    size: runtimeConfig.imageSize,
    quality: runtimeConfig.imageQuality,
    style: runtimeConfig.imageStyle,
    background: runtimeConfig.imageBackground,
    output_format: runtimeConfig.outputFormat,
    output_compression: runtimeConfig.imageOutputCompression,
    response_format: runtimeConfig.responseFormat
  };

  if (options.stream) {
    body.stream = true;
    body.partial_images = Math.max(
      0,
      Math.min(3, Number(options.partialImages ?? CREATE_AGENT_STREAM_PARTIAL_IMAGES) || 0)
    );
  }
  return body;
}

function buildChatCompletionsImagePrompt(prompt = '', runtimeConfig = {}) {
  const responseFormat = String(runtimeConfig.responseFormat || 'b64_json').trim().toLowerCase();
  const lines = [
    'Generate exactly one high-quality image that follows the prompt below.',
    `Prompt: ${String(prompt || '').trim()}`,
    `Image size: ${String(runtimeConfig.imageSize || '1024x1024').trim()}`,
    `Quality: ${String(runtimeConfig.imageQuality || 'high').trim()}`,
    `Style: ${String(runtimeConfig.imageStyle || 'vivid').trim()}`,
    `Background: ${String(runtimeConfig.imageBackground || 'auto').trim()}`,
    `Output format: ${String(runtimeConfig.outputFormat || 'png').trim()}`,
    `Response format preference: ${responseFormat}`,
    responseFormat === 'url'
      ? 'Return only a direct image URL or a data:image/... URL when possible. Do not return prose.'
      : 'If returning JSON, return one complete final image payload such as {"b64_json":"..."} without truncation or splitting across content blocks.',
    'Return image output only.'
  ];
  return lines.join('\n');
}

function buildChatCompletionsImageRequestBody(prompt = '', runtimeConfig = {}, options = {}) {
  return {
    model: runtimeConfig.model,
    messages: [
      {
        role: 'user',
        content: buildChatCompletionsImagePrompt(prompt, runtimeConfig)
      }
    ],
    stream: Boolean(options.stream)
  };
}

function omitObjectKeys(source = {}, keys = []) {
  const next = { ...(source && typeof source === 'object' ? source : {}) };
  for (const key of (Array.isArray(keys) ? keys : [])) {
    delete next[String(key || '').trim()];
  }
  return next;
}

function pickObjectKeys(source = {}, keys = []) {
  const next = {};
  const rawSource = source && typeof source === 'object' ? source : {};
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    if (!Object.prototype.hasOwnProperty.call(rawSource, normalizedKey)) continue;
    next[normalizedKey] = rawSource[normalizedKey];
  }
  return next;
}

function buildImageGenerationRequestBodyVariants(prompt = '', runtimeConfig = {}, options = {}) {
  const fullBody = buildImageGenerationRequestBody(prompt, runtimeConfig, options);
  const variants = [
    fullBody,
    omitObjectKeys(fullBody, ['style']),
    omitObjectKeys(fullBody, ['style', 'background']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression', 'quality']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression', 'quality', 'response_format'])
  ];

  if (options.stream) {
    variants.push(
      omitObjectKeys(fullBody, [
        'style',
        'background',
        'output_format',
        'output_compression',
        'quality',
        'response_format',
        'partial_images'
      ])
    );
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'size', 'stream']));
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'stream']));
  } else {
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'size']));
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt']));
  }

  const seen = new Set();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function writeImageBuffer(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  validateImageBuffer(buffer, mimeType);
  const outputPath = buildImageOutputPath(runtimeConfig, prompt, buffer, mimeType);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function downloadImageFromUrl(imageUrl = '', prompt = '', runtimeConfig = {}, deps = {}) {
  const rawUrl = String(imageUrl || '').trim();
  if (!rawUrl) {
    throw new Error('generation response missing image data');
  }

  const dataUrlMatch = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const buffer = Buffer.from(normalizeBase64ImageData(dataUrlMatch[2] || ''), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer, dataUrlMatch[1]);
    return { filePath, buffer };
  }

  const httpClient = deps.httpClient || axios;
  try {
    const response = await httpClient.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: runtimeConfig.timeoutMs,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      proxy: false
    });
    const buffer = Buffer.from(response?.data || []);
    const filePath = writeImageBuffer(
      runtimeConfig,
      prompt,
      buffer,
      String(response?.headers?.['content-type'] || '').trim()
    );
    return { filePath, buffer };
  } catch (error) {
    throw new Error(normalizeRequestError(error));
  }
}

async function materializeGeneratedImage(imageResult = null, prompt = '', runtimeConfig = {}, deps = {}) {
  if (!imageResult || typeof imageResult !== 'object') {
    throw new Error('generation response missing image data');
  }

  if (imageResult.kind === 'b64_json') {
    const buffer = Buffer.from(normalizeBase64ImageData(imageResult.value || ''), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer);
    return { filePath, buffer };
  }

  if (imageResult.kind === 'url') {
    return downloadImageFromUrl(imageResult.value, prompt, runtimeConfig, deps);
  }

  throw new Error('generation response missing image data');
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

function buildUserFacingFailureReply(error = null, runtimeConfig = {}) {
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  const providerModelMatch = message.match(/unknown provider for model\s+([a-z0-9._-]+)/i);
  const providerModel = String(providerModelMatch?.[1] || runtimeConfig.model || '').trim();
  if (!message) return '生图失败，请稍后重试';
  if (lower.includes('create_agent_api_base_url')) return '生图接口未配置';
  if (lower.includes('create_agent_api_key')) return '生图鉴权未配置';
  if (lower.includes('create_agent_model')) return '生图模型未配置';
  if (message.includes('系统网关次数不足') || message.includes('网关次数不足')) {
    return '生图供应商额度不足，请联系服务商';
  }
  if (lower.includes('error 524') || lower.includes('origin_response_timeout') || lower.includes('cloudflare') && lower.includes('524')) {
    return '生图上游超时，请稍后重试或更换供应商';
  }
  if (lower.includes('unknown provider for model')) {
    return `当前生图供应商不支持 ${providerModel || '该模型'}`;
  }
  if (lower.includes('chat completions endpoint returned html')) return '当前生图接口路径不兼容，供应商返回了网页页面';
  if (lower.includes('http_error') && lower.includes('400')) return '生图请求参数无效';
  if (lower.includes('http_error') && lower.includes('404')) return '当前生图接口不存在';
  if (lower.includes('http_error') && (lower.includes('401') || lower.includes('403'))) return '生图鉴权失败';
  if (lower.includes('http_error') && lower.includes('429')) return '生图接口限流，请稍后重试';
  if (lower.includes('http_error') && lower.includes('5')) return '生图供应商暂时异常';
  if (lower.includes('generation stream missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('generation response missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('image buffer invalid or truncated')) return '生图结果损坏，供应商返回了不完整图片';
  if (lower.includes('image buffer empty')) return '生图结果为空';
  if (lower.includes('napcat action send_group_msg')) return '图片发送失败，请稍后重试';
  if (lower.includes('timeout') || lower.includes('timed out')) return '生图超时，请稍后重试';
  if (lower.includes('network_error')) return '生图网络异常，请稍后重试';
  return '生图失败，请稍后重试';
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
