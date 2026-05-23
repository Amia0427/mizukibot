const config = require('../config');
const { postWithRetry: defaultPostWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { readCachedImagePayload } = require('./imageInputCache');
const {
  loadImageMemoryIndex,
  upsertImageMemory
} = require('./imageMemoryIndex');
const {
  materializeMemoryViews
} = require('./memory-v3/materializer');
const { formatDateInTz, getDatePartsInTz } = require('./time');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeId(value = '') {
  return normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160);
}

function ensureChatCompletionsUrl(url = '') {
  const u = normalizeText(url).replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function getMemoryModelName() {
  return normalizeText(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

function getMemoryApiBaseUrl() {
  return normalizeText(config.MEMORY_API_BASE_URL || config.API_BASE_URL);
}

function getMemoryApiKey() {
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
      type: 'input_image',
      media_type: normalizeText(imagePayload.mediaType || 'image/jpeg') || 'image/jpeg',
      data: String(imagePayload.data || '')
    }
  ];
}

function shouldSkipExistingSummary(cacheKey = '', options = {}) {
  if (options.force === true) return false;
  const record = loadImageMemoryIndex().images[cacheKey] || null;
  return Boolean(normalizeText(record?.summary));
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

  const postWithRetry = typeof deps.postWithRetry === 'function'
    ? deps.postWithRetry
    : defaultPostWithRetry;
  const timestampText = buildShortTimestamp(context.now instanceof Date ? context.now : new Date());
  const response = await postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: 0.1,
      top_p: 0.85,
      max_tokens: Math.max(80, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_MAX_TOKENS || 180) || 180),
      stream: false,
      messages: [
        {
          role: 'user',
          content: buildRequestContent(imagePayload, context)
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_TIMEOUT_MS || 12000) || 12000),
      __trace: {
        source: 'image_visual_summary_memory',
        phase: 'visual_summary',
        purpose: 'image_long_term_memory',
        routePolicyKey: 'memory/image-visual-summary',
        topRouteType: 'vision',
        userId: normalizeText(context.userId)
      }
    },
    Math.max(0, Math.min(1, Number(config.IMAGE_MEMORY_VISUAL_SUMMARY_RETRIES || 0) || 0)),
    getMemoryApiKey()
  );

  const summary = formatSummaryWithTimestamp(extractResponseText(response), timestampText);
  if (!summary) {
    return { ok: false, skipped: false, reason: 'empty_summary', summary: '', cacheKey, model };
  }
  return {
    ok: true,
    skipped: false,
    reason: '',
    cacheKey,
    summary,
    model,
    timestampText,
    mediaType: imagePayload.mediaType,
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
      summary: generated.summary
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
  summarizeImageIntoLongTermMemory
};
