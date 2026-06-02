const config = require('../config');
const { postWithRetry: defaultPostWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { readCachedImagePayload } = require('./imageInputCache');
const {
  loadImageMemoryIndex,
  saveImageMemoryIndex,
  upsertImageMemory
} = require('./imageMemoryIndex');
const {
  materializeMemoryViews
} = require('./memory-v3/materializer');
const { formatDateInTz, getDatePartsInTz } = require('./time');

const VISUAL_SUMMARY_IMAGE_MAX_EDGE = 1024;
const VISUAL_SUMMARY_REQUEST_SHAPE = 'chat_completions_image_url_data_url';
const routeCooldowns = new Map();

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeId(value = '') {
  return normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160);
}

function buildCacheRef(cacheKey = '') {
  const normalized = normalizeId(cacheKey);
  return normalized ? `cached-image://${normalized}` : '';
}

function parseCacheKeyFromImageRef(value = '') {
  const text = normalizeText(value);
  if (!text.startsWith('cached-image://')) return '';
  return normalizeId(text.slice('cached-image://'.length));
}

function normalizeTimestampMs(value = null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

function ensureChatCompletionsUrl(url = '') {
  const u = normalizeText(url).replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function getMemoryModelName() {
  return normalizeText(config.IMAGE_MEMORY_VISUAL_SUMMARY_MODEL || config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

function getMemoryApiBaseUrl() {
  return normalizeText(config.IMAGE_MEMORY_VISUAL_SUMMARY_API_BASE_URL || config.MEMORY_API_BASE_URL || config.API_BASE_URL);
}

function getMemoryApiKey() {
  if (normalizeText(config.IMAGE_MEMORY_VISUAL_SUMMARY_API_BASE_URL)) {
    return normalizeText(config.IMAGE_MEMORY_VISUAL_SUMMARY_API_KEY || config.MEMORY_API_KEY || config.API_KEY);
  }
  if (normalizeText(config.MEMORY_API_BASE_URL)) {
    return normalizeText(config.MEMORY_API_KEY || config.API_KEY);
  }
  return normalizeText(config.API_KEY);
}

function buildShortTimestamp(date = new Date(), timezone = config.TIMEZONE || 'Asia/Shanghai') {
  const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const day = formatDateInTz(safeDate, timezone);
  const parts = getDatePartsInTz(safeDate, timezone);
  return `${day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function clampSummary(text = '', maxChars = config.IMAGE_MEMORY_VISUAL_SUMMARY_MAX_CHARS || 220) {
  const normalized = normalizeText(text)
    .replace(/^视觉摘要[:：]\s*/i, '')
    .replace(/^\[[^\]]{8,32}\]\s*/, '')
    .trim();
  const limit = Math.max(40, Number(maxChars || 220) || 220);
  return normalized.length > limit ? normalized.slice(0, limit).trim() : normalized;
}

function formatSummaryWithTimestamp(summary = '', timestampText = '') {
  const clean = clampSummary(summary);
  const ts = normalizeText(timestampText);
  if (!clean) return '';
  if (!ts) return clean;
  if (clean.startsWith(`[${ts}]`)) return clean;
  return `[${ts}] ${clean}`;
}

function isLikelyUnsupportedVisualSummaryModel(model = '') {
  const text = normalizeText(model).toLowerCase();
  if (!text) return true;
  if (/(vision|visual|vl\b|qwen2(?:\.5)?-vl|qwen-vl|internvl|llava|glm-4v|gpt-4o|gpt-4\.1|gpt-5|gemini|claude)/i.test(text)) {
    return false;
  }
  return /(^|[/\s:_-])deepseek(?!.*(?:vl|vision|visual))/.test(text)
    || /embedding|rerank|bge|text-embedding/.test(text);
}

function validateVisualSummaryImagePayload(imagePayload = {}) {
  const mediaType = normalizeText(imagePayload.mediaType || 'image/jpeg').toLowerCase();
  const data = String(imagePayload.data || '').trim();
  if (!data) return { ok: false, reason: 'missing_image_data' };
  if (!/^image\/(?:jpeg|jpg|png|webp|gif)$/i.test(mediaType)) {
    return { ok: false, reason: 'unsupported_image_media_type' };
  }

  let buffer = null;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch (_) {
    return { ok: false, reason: 'invalid_image_base64' };
  }
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty_image_payload' };
  const maxBytes = Math.max(1024, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_MAX_BYTES || 4 * 1024 * 1024) || 4 * 1024 * 1024);
  if (buffer.length > maxBytes) return { ok: false, reason: 'image_payload_too_large' };

  const startsWithHex = (hex) => buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const isPng = startsWithHex('89504e470d0a1a0a');
  const isJpeg = startsWithHex('ffd8ff');
  const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const gifSig = buffer.subarray(0, 6).toString('ascii');
  const isGif = gifSig === 'GIF87a' || gifSig === 'GIF89a';
  if (!isPng && !isJpeg && !isWebp && !isGif) return { ok: false, reason: 'invalid_image_signature' };
  return { ok: true, reason: '', byteLength: buffer.length };
}

function buildImageDataUrl(imagePayload = {}) {
  const mediaType = normalizeText(imagePayload.mediaType || 'image/jpeg') || 'image/jpeg';
  return `data:${mediaType};base64,${String(imagePayload.data || '').trim()}`;
}

function extractResponseText(response = {}) {
  const msg = extractMessageContent(response);
  const text = normalizeText(msg?.content || msg?.text || '');
  if (text) return text;
  const raw = response?.data;
  if (typeof raw === 'string') return normalizeText(raw);
  return normalizeText(raw?.output_text || raw?.text || raw?.content);
}

function buildVisualSummaryPrompt(context = {}) {
  const userText = normalizeText(context.userText);
  const imageSource = normalizeText(context.imageSource || context.label);
  return [
    '你是长期记忆的图片视觉摘要模型。',
    '任务：只根据图片可见内容，生成一条适合长期记忆检索的中文视觉摘要。',
    '要求：',
    '- 只写可见事实，不推断不可见背景。',
    '- 如果是游戏/战绩/分数/结算/截图，要保留这些关键词和可见数字、文字、排行、分数等。',
    '- 如果能看见文字，简短纳入摘要。',
    '- 不要输出 JSON、markdown、解释或前后缀。',
    '- 40 到 120 个中文字符。',
    userText ? `用户随图文本：${userText}` : '',
    imageSource ? `图片来源：${imageSource}` : ''
  ].filter(Boolean).join('\n');
}

function buildRequestContent(imagePayload = {}, context = {}) {
  return [
    {
      type: 'text',
      text: buildVisualSummaryPrompt(context)
    },
    {
      type: 'image_url',
      image_url: {
        url: buildImageDataUrl(imagePayload),
        detail: 'low'
      }
    }
  ];
}

async function normalizeVisualSummaryImagePayload(imagePayload = {}) {
  const data = String(imagePayload?.data || '').trim();
  if (!data) return imagePayload;

  try {
    const sharp = require('sharp');
    const inputBuffer = Buffer.from(data, 'base64');
    const metadata = await sharp(inputBuffer, { animated: false, limitInputPixels: 50000000 }).metadata();
    const width = Number(metadata?.width || 0);
    const height = Number(metadata?.height || 0);
    if (
      Number.isFinite(width)
      && Number.isFinite(height)
      && width <= VISUAL_SUMMARY_IMAGE_MAX_EDGE
      && height <= VISUAL_SUMMARY_IMAGE_MAX_EDGE
      && normalizeText(imagePayload.mediaType).toLowerCase() === 'image/jpeg'
    ) {
      return imagePayload;
    }

    const outputBuffer = await sharp(inputBuffer, { animated: false, limitInputPixels: 50000000 })
      .rotate()
      .resize({
        width: VISUAL_SUMMARY_IMAGE_MAX_EDGE,
        height: VISUAL_SUMMARY_IMAGE_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    return {
      ...imagePayload,
      data: outputBuffer.toString('base64'),
      mediaType: 'image/jpeg',
      originalMediaType: imagePayload.mediaType,
      originalByteLength: imagePayload.byteLength || inputBuffer.length
    };
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[image-visual-summary] failed to normalize image payload:', error?.message || error);
    }
    return imagePayload;
  }
}

function shouldSkipExistingSummary(cacheKey = '', options = {}) {
  if (options.force === true) return false;
  const record = loadImageMemoryIndex().images[cacheKey] || null;
  return Boolean(normalizeText(record?.summary));
}

function getActiveImageCooldown(cacheKey = '', options = {}) {
  if (options.force === true) return null;
  const now = normalizeTimestampMs(options.now);
  const state = loadImageMemoryIndex().images[cacheKey]?.visualSummaryState || null;
  const nextRetryAt = Number(state?.nextRetryAt || 0);
  if (Number.isFinite(nextRetryAt) && nextRetryAt > now) {
    return { ...state, nextRetryAt };
  }
  return null;
}

function buildRouteCooldownKey(apiBaseUrl = '', model = '') {
  return `${normalizeText(apiBaseUrl).toLowerCase()}|${normalizeText(model).toLowerCase()}`;
}

function getActiveRouteCooldown(apiBaseUrl = '', model = '', options = {}) {
  if (options.force === true) return null;
  const key = buildRouteCooldownKey(apiBaseUrl, model);
  const state = routeCooldowns.get(key);
  const now = normalizeTimestampMs(options.now);
  if (state && Number(state.nextRetryAt || 0) > now) return { ...state };
  if (state) routeCooldowns.delete(key);
  return null;
}

function classifyVisualSummaryError(error = null) {
  const status = Number(error?.response?.status || error?.status || 0);
  const message = normalizeText(error?.message || error);
  const lower = message.toLowerCase();
  if (status === 400) return { reason: 'http_400', errorClass: 'http_400', transient: false };
  if (status === 413) return { reason: 'http_413', errorClass: 'http_413', transient: false };
  if (status === 415) return { reason: 'http_415', errorClass: 'http_415', transient: false };
  if (status === 429) return { reason: 'rate_limited', errorClass: 'http_429', transient: true };
  if (status >= 500) return { reason: `http_${status}`, errorClass: `http_${status}`, transient: true };
  if (/socket hang up|econnreset/.test(lower)) return { reason: 'socket_hang_up', errorClass: 'socket_hang_up', transient: true };
  if (/timeout|etimedout|aborted/.test(lower)) return { reason: 'request_timeout', errorClass: 'request_timeout', transient: true };
  return { reason: message || 'visual_summary_failed', errorClass: 'request_failed', transient: true };
}

function getVisualSummaryCooldownMs(transient = false) {
  const fallback = transient ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const configured = transient
    ? config.IMAGE_MEMORY_VISUAL_SUMMARY_TRANSIENT_COOLDOWN_MS
    : config.IMAGE_MEMORY_VISUAL_SUMMARY_COOLDOWN_MS;
  return Math.max(60 * 1000, Number(configured || fallback) || fallback);
}

function recordVisualSummaryFailure(cacheKey = '', input = {}) {
  const normalizedCacheKey = normalizeId(cacheKey || input.cacheKey || parseCacheKeyFromImageRef(input.imageRef));
  if (!normalizedCacheKey) return null;
  const now = normalizeTimestampMs(input.now);
  const index = loadImageMemoryIndex();
  const existing = index.images[normalizedCacheKey] || {};
  const existingState = existing.visualSummaryState || {};
  const classified = input.classified || { reason: normalizeText(input.reason || 'visual_summary_failed'), errorClass: normalizeText(input.errorClass || 'request_failed'), transient: Boolean(input.transient) };
  const cooldownMs = Math.max(60 * 1000, Number(input.cooldownMs || getVisualSummaryCooldownMs(classified.transient)) || getVisualSummaryCooldownMs(classified.transient));
  const state = {
    status: 'cooldown',
    failureCount: Math.max(0, Number(existingState.failureCount || 0) || 0) + 1,
    lastAttemptAt: now,
    lastFailedAt: now,
    nextRetryAt: now + cooldownMs,
    reason: normalizeText(classified.reason || input.reason || 'visual_summary_failed').slice(0, 160),
    errorClass: normalizeText(classified.errorClass || input.errorClass || 'request_failed').slice(0, 80),
    model: normalizeText(input.model).slice(0, 160),
    apiBaseUrl: normalizeText(input.apiBaseUrl).slice(0, 240),
    requestShape: VISUAL_SUMMARY_REQUEST_SHAPE
  };
  index.images[normalizedCacheKey] = {
    ...(existing || {}),
    cacheKey: normalizedCacheKey,
    imageRef: normalizeText(existing.imageRef || input.imageRef || buildCacheRef(normalizedCacheKey)),
    sourceUrl: normalizeText(existing.sourceUrl || input.sourceUrl),
    mediaType: normalizeText(existing.mediaType || input.mediaType || 'image/jpeg') || 'image/jpeg',
    visualSummaryState: state
  };
  saveImageMemoryIndex(index);
  return state;
}

function activateRouteCooldown(apiBaseUrl = '', model = '', classified = {}, options = {}) {
  if (!apiBaseUrl || !model) return null;
  if (classified.transient !== true && classified.reason !== 'http_400' && classified.reason !== 'http_413' && classified.reason !== 'http_415') return null;
  const now = normalizeTimestampMs(options.now);
  const configured = Math.max(60 * 1000, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_ROUTE_COOLDOWN_MS || 30 * 60 * 1000) || 30 * 60 * 1000);
  const state = {
    reason: classified.reason || 'visual_summary_failed',
    errorClass: classified.errorClass || 'request_failed',
    nextRetryAt: now + configured
  };
  routeCooldowns.set(buildRouteCooldownKey(apiBaseUrl, model), state);
  return state;
}

async function generateImageVisualSummary(imageRef = '', context = {}, deps = {}) {
  if (config.IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED === false && context.force !== true) {
    return { ok: false, skipped: true, reason: 'disabled', summary: '' };
  }
  const imagePayload = readCachedImagePayload(imageRef);
  if (!imagePayload || !imagePayload.data) {
    return { ok: false, skipped: true, reason: 'cached_image_missing', summary: '' };
  }
  const cacheKey = normalizeId(imagePayload.cacheKey);
  if (!cacheKey) return { ok: false, skipped: true, reason: 'missing_cache_key', summary: '' };
  if (shouldSkipExistingSummary(cacheKey, context)) {
    const existing = loadImageMemoryIndex().images[cacheKey] || {};
    return { ok: true, skipped: true, reason: 'summary_exists', summary: normalizeText(existing.summary), cacheKey };
  }

  const apiBaseUrl = ensureChatCompletionsUrl(getMemoryApiBaseUrl());
  const model = getMemoryModelName();
  if (!apiBaseUrl || !model) {
    return { ok: false, skipped: true, reason: 'memory_model_missing', summary: '', cacheKey };
  }
  if (isLikelyUnsupportedVisualSummaryModel(model) && context.force !== true) {
    const state = recordVisualSummaryFailure(cacheKey, {
      ...context,
      imageRef,
      sourceUrl: imagePayload.sourceUrl,
      mediaType: imagePayload.mediaType,
      model,
      apiBaseUrl,
      reason: 'visual_model_not_vision_capable',
      errorClass: 'model_precheck',
      transient: false
    });
    return { ok: false, skipped: true, reason: 'visual_model_not_vision_capable', summary: '', cacheKey, model, cooldownUntil: state?.nextRetryAt || 0 };
  }
  const imageCooldown = getActiveImageCooldown(cacheKey, context);
  if (imageCooldown) {
    return { ok: false, skipped: true, reason: 'visual_summary_cooldown', summary: '', cacheKey, model, cooldownUntil: imageCooldown.nextRetryAt };
  }
  const routeCooldown = getActiveRouteCooldown(apiBaseUrl, model, context);
  if (routeCooldown) {
    return { ok: false, skipped: true, reason: 'visual_summary_route_cooldown', summary: '', cacheKey, model, cooldownUntil: routeCooldown.nextRetryAt };
  }

  const postWithRetry = typeof deps.postWithRetry === 'function'
    ? deps.postWithRetry
    : defaultPostWithRetry;
  const timestampText = buildShortTimestamp(context.now instanceof Date ? context.now : new Date());
  const requestImagePayload = await normalizeVisualSummaryImagePayload(imagePayload);
  const validation = validateVisualSummaryImagePayload(requestImagePayload);
  if (!validation.ok) {
    const state = recordVisualSummaryFailure(cacheKey, {
      ...context,
      imageRef,
      sourceUrl: imagePayload.sourceUrl,
      mediaType: requestImagePayload.mediaType,
      model,
      apiBaseUrl,
      reason: validation.reason,
      errorClass: 'payload_precheck',
      transient: false
    });
    return { ok: false, skipped: true, reason: validation.reason, summary: '', cacheKey, model, cooldownUntil: state?.nextRetryAt || 0 };
  }

  let response = null;
  try {
    response = await postWithRetry(
      apiBaseUrl,
      {
        model,
        temperature: 0.1,
        max_tokens: Math.max(80, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_MAX_TOKENS || 180) || 180),
        stream: false,
        messages: [
          {
            role: 'user',
            content: buildRequestContent(requestImagePayload, context)
          }
        ],
        __preferredProtocol: 'chat_completions',
        __timeoutMs: Math.max(1000, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_TIMEOUT_MS || 25000) || 25000),
        __trace: {
          source: 'image_visual_summary_memory',
          phase: 'visual_summary',
          purpose: 'image_long_term_memory',
          routePolicyKey: 'memory/image-visual-summary',
          routeDebugKey: 'memory/image-visual-summary',
          topRouteType: 'vision',
          userId: normalizeText(context.userId)
        }
      },
      Math.max(0, Math.min(1, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_RETRIES || 0) || 0)),
      getMemoryApiKey()
    );
  } catch (error) {
    const classified = classifyVisualSummaryError(error);
    const state = recordVisualSummaryFailure(cacheKey, {
      ...context,
      imageRef,
      sourceUrl: imagePayload.sourceUrl,
      mediaType: requestImagePayload.mediaType,
      model,
      apiBaseUrl,
      classified
    });
    activateRouteCooldown(apiBaseUrl, model, classified, context);
    if (config.ENABLE_DEBUG_LOG) {
      const until = state?.nextRetryAt ? new Date(state.nextRetryAt).toISOString() : '';
      console.warn(`[image-visual-summary] failed: ${classified.reason}${until ? `; cooldown until ${until}` : ''}`);
    }
    return { ok: false, skipped: false, reason: classified.reason, summary: '', cacheKey, model, cooldownUntil: state?.nextRetryAt || 0 };
  }

  const summary = formatSummaryWithTimestamp(extractResponseText(response), timestampText);
  if (!summary) {
    const state = recordVisualSummaryFailure(cacheKey, {
      ...context,
      imageRef,
      sourceUrl: imagePayload.sourceUrl,
      mediaType: requestImagePayload.mediaType,
      model,
      apiBaseUrl,
      reason: 'empty_summary',
      errorClass: 'empty_summary',
      transient: true
    });
    return { ok: false, skipped: false, reason: 'empty_summary', summary: '', cacheKey, model, cooldownUntil: state?.nextRetryAt || 0 };
  }
  return {
    ok: true,
    skipped: false,
    reason: '',
    cacheKey,
    summary,
    model,
    timestampText,
    mediaType: requestImagePayload.mediaType,
    sourceUrl: imagePayload.sourceUrl
  };
}

function buildImageMemoryEvent(summaryResult = {}, context = {}) {
  const cacheKey = normalizeId(summaryResult.cacheKey || context.cacheKey);
  const userId = normalizeText(context.userId);
  const groupId = normalizeText(context.groupId);
  const summary = normalizeText(summaryResult.summary);
  if (!cacheKey || !summary) return null;
  return {
    type: 'memory_confirmed',
    userId,
    groupId,
    sessionKey: normalizeText(context.sessionKey),
    scopeType: groupId ? 'group' : 'personal',
    source: 'image_visual_summary',
    sourceKind: 'vision',
    status: 'active',
    confidence: 0.82,
    importance: 0.86,
    evidenceCount: 1,
    memoryKind: 'image',
    semanticSlot: 'image_visual_summary',
    canonicalKey: `image:${cacheKey}`,
    dedupeKey: `image_visual_summary:${cacheKey}`,
    text: summary,
    payload: {
      type: 'image',
      cacheKey,
      imageRef: normalizeText(context.imageRef),
      sourceUrl: normalizeText(summaryResult.sourceUrl || context.sourceUrl),
      mediaType: normalizeText(summaryResult.mediaType || context.mediaType),
      messageId: normalizeText(context.messageId),
      sourceMessageId: normalizeText(context.sourceMessageId),
      imageSource: normalizeText(context.imageSource),
      label: normalizeText(context.label),
      userText: normalizeText(context.userText),
      model: normalizeText(summaryResult.model),
      timestampText: normalizeText(summaryResult.timestampText)
    }
  };
}

function appendVersionedMemoryUpdate(...args) {
  return require('./memory-v3').appendVersionedMemoryUpdate(...args);
}

async function summarizeImageIntoLongTermMemory(imageRef = '', context = {}, deps = {}) {
  try {
    const generated = await generateImageVisualSummary(imageRef, context, deps);
    if (!generated.ok || !generated.summary || generated.skipped) return generated;

    const cacheKey = normalizeId(generated.cacheKey);
    const imageMemoryResult = upsertImageMemory({
      cacheKey,
      imageRef,
      sourceUrl: generated.sourceUrl || context.sourceUrl,
      mediaType: generated.mediaType || context.mediaType,
      userId: context.userId,
      groupId: context.groupId,
      sessionKey: context.sessionKey,
      messageId: context.messageId,
      sourceMessageId: context.sourceMessageId,
      imageSource: context.imageSource,
      label: context.label,
      source: 'image_visual_summary',
      userText: context.userText,
      summary: generated.summary,
      visualSummaryState: {
        status: 'ok',
        lastAttemptAt: Date.now(),
        requestShape: VISUAL_SUMMARY_REQUEST_SHAPE,
        model: generated.model
      }
    });

    let event = null;
    if (config.MEMORY_V3_ENABLED !== false) {
      const versioned = await appendVersionedMemoryUpdate(buildImageMemoryEvent(generated, {
        ...context,
        cacheKey,
        imageRef,
        sourceUrl: generated.sourceUrl,
        mediaType: generated.mediaType
      }));
      event = versioned.event || null;
      materializeMemoryViews({
        mode: 'incremental',
        userId: context.userId,
        groupId: context.groupId,
        sessionKey: context.sessionKey,
        scheduleEmbeddingBackfill: true
      });
    }

    return {
      ...generated,
      imageMemory: imageMemoryResult,
      event
    };
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[image-visual-summary] failed:', error?.message || error);
    }
    return {
      ok: false,
      skipped: false,
      reason: error?.message || 'visual_summary_failed',
      summary: ''
    };
  }
}

function enqueueImageVisualSummary(imageRef = '', context = {}, deps = {}) {
  if (config.IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED === false && context.force !== true) {
    return { queued: false, reason: 'disabled' };
  }
  const promise = summarizeImageIntoLongTermMemory(imageRef, context, deps);
  if (context.awaitSummary === true) {
    return { queued: true, promise };
  }
  void promise.catch((error) => {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[image-visual-summary] async failed:', error?.message || error);
    }
  });
  return { queued: true };
}

module.exports = {
  buildImageMemoryEvent,
  buildRequestContent,
  buildShortTimestamp,
  enqueueImageVisualSummary,
  formatSummaryWithTimestamp,
  generateImageVisualSummary,
  normalizeVisualSummaryImagePayload,
  summarizeImageIntoLongTermMemory
};
