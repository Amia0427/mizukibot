const config = require('../config');
const {
  getMessageByIdCached,
  getForwardMessagesByIdCached
} = require('../api/napcatMessageReader');
const { ensureCachedImageRef } = require('../utils/imageInputCache');
const { upsertImageMemory } = require('../utils/imageMemoryIndex');
const {
  appendCardUrlsToText,
  appendPromptLine,
  canonicalizeKnownShareUrl,
  collectMessageContent,
  extractTextAndImagesFromMessage,
  extractUrlsFromJsonPayload,
  extractUrlsFromRawJsonSegments,
  identifyCardPlatform,
  normalizeText,
  parseRawForwardIds,
  parseRawImageUrls,
  parseRawReplyId,
  safeJsonParse,
  segmentData,
  segmentTypeName,
  senderIdFromMessage,
  senderNameFromMessage,
  stripCqControlSegments,
  uniqueStrings
} = require('./continuousMessage/contentExtraction');

function stripSemanticClassifierNoise(text = '') {
  return String(text || '')
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => line && line !== '[图片]' && !/^\[(引用消息|转发消息|引用图片|转发图片|分享链接)\]/.test(line))
    .filter((line) => !/^\[CQ:image,/i.test(line))
    .join('\n')
    .trim();
}

function seemsSentenceComplete(text = '', options = {}) {
  const clean = stripSemanticClassifierNoise(text);
  if (!clean) {
    return { complete: false, reason: 'empty' };
  }

  const minChars = Math.max(1, Number(options.minChars || 6) || 6);
  const tail = clean.slice(-1);
  const trimmedLen = clean.replace(/\s+/g, '').length;

  if (/[。！？!?；;~～…]$/.test(clean)) {
    return { complete: true, reason: 'terminal_punctuation' };
  }

  if (/[，,、：:]$/.test(clean)) {
    return { complete: false, reason: 'weak_punctuation' };
  }

  if (/(然后|还有|等下|等等|先|就是|我还没说完|补一句|继续说|如果|但是|不过)$/.test(clean)) {
    return { complete: false, reason: 'continuation_tail' };
  }

  if (clean.includes('(') && !clean.includes(')')) {
    return { complete: false, reason: 'open_paren' };
  }
  if (clean.includes('（') && !clean.includes('）')) {
    return { complete: false, reason: 'open_zh_paren' };
  }
  if (/[“‘「『《]$/.test(clean)) {
    return { complete: false, reason: 'opening_quote' };
  }
  if (trimmedLen < minChars) {
    return { complete: false, reason: 'too_short' };
  }
  if (tail && /[a-zA-Z0-9\u4e00-\u9fa5]/.test(tail)) {
    return { complete: true, reason: 'stable_tail' };
  }
  return { complete: false, reason: 'unknown' };
}

function clampDebounceMs(value, fallback = 2000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(300, Math.min(60000, Math.floor(n)));
}

function cloneReplyContext(replyContext = null) {
  if (!replyContext || typeof replyContext !== 'object') return null;
  return {
    ...replyContext,
    imageUrls: Array.isArray(replyContext.imageUrls) ? replyContext.imageUrls.slice() : [],
    imageRefMap: replyContext.imageRefMap && typeof replyContext.imageRefMap === 'object'
      ? { ...replyContext.imageRefMap }
      : {}
  };
}

async function buildImageRefMap(urls = [], options = {}) {
  const ensureImageRef = typeof options.ensureCachedImageRef === 'function'
    ? options.ensureCachedImageRef
    : ensureCachedImageRef;
  const out = {};
  for (const url of uniqueStrings(Array.isArray(urls) ? urls : [])) {
    const cached = await ensureImageRef(url, {
      timeoutMs: options.imageCacheTimeoutMs,
      maxBytes: options.imageCacheMaxBytes
    });
    if (cached.ok && cached.ref) {
      out[url] = cached.ref;
      const cacheKey = String(cached.cacheKey || cached.ref.replace(/^cached-image:\/\//i, '')).trim();
      upsertImageMemory({
        cacheKey,
        imageRef: cached.ref,
        sourceUrl: cached.sourceUrl || url,
        mediaType: cached.mediaType,
        userId: options.userId,
        groupId: options.groupId,
        sessionKey: options.sessionKey,
        messageId: options.messageId,
        sourceMessageId: options.sourceMessageId,
        imageSource: options.imageSource,
        label: options.label,
        source: 'continuous_message',
        userText: options.userText
      });
    }
  }
  return out;
}

function buildReplyContextPromptLines(replyContext = null) {
  const context = cloneReplyContext(replyContext);
  if (!context) return [];
  const lines = [];
  const senderName = normalizeText(context.senderName || context.senderId || '');
  const origin = normalizeText(context.origin || '');
  const text = normalizeText(context.text || '');
  if (senderName || origin) {
    lines.push(`[引用消息] ${[senderName, origin].filter(Boolean).join(' / ')}`.trim());
  } else {
    lines.push('[引用消息]');
  }
  if (text) lines.push(text);
  if (Array.isArray(context.imageUrls) && context.imageUrls.length) {
    for (const url of context.imageUrls) {
      const normalized = normalizeText(url);
      if (!normalized) continue;
      lines.push('[引用图片]');
      lines.push(`[CQ:image,url=${normalized}]`);
    }
  }
  return lines;
}

function buildForwardPromptLines(forwardSummaryText = '', forwardImageUrls = []) {
  const summary = normalizeText(forwardSummaryText);
  const lines = [];
  if (summary) {
    lines.push('[转发消息]');
    lines.push(summary);
  }
  if (Array.isArray(forwardImageUrls) && forwardImageUrls.length) {
    for (const url of uniqueStrings(forwardImageUrls.map((item) => normalizeText(item)).filter(Boolean))) {
      lines.push('[转发图片]');
      lines.push(`[CQ:image,url=${url}]`);
    }
  }
  return lines;
}

function parseForwardNodeRawContent(rawContent) {
  if (Array.isArray(rawContent)) return rawContent;
  if (typeof rawContent === 'string') {
    const parsed = safeJsonParse(rawContent);
    if (Array.isArray(parsed)) return parsed;
    return rawContent.trim() ? [{ type: 'text', data: { text: rawContent } }] : [];
  }
  return [];
}

function textFromForwardNode(rawContent) {
  const textParts = [];
  const imageUrls = [];
  for (const segment of parseForwardNodeRawContent(rawContent)) {
    const type = segmentTypeName(segment);
    const data = segmentData(segment);
    if (type === 'text') {
      const text = normalizeText(data.text || '');
      if (text) textParts.push(text);
    } else if (type === 'image') {
      const url = normalizeText(data.url || data.file || '');
      if (url) imageUrls.push(url);
      textParts.push('[图片]');
    }
  }
  return {
    text: textParts.join('').trim(),
    imageUrls
  };
}

function normalizeMessageForDownstream(baseMsg = {}, merged = {}, effectiveBotQQ = '') {
  const atPrefix = merged.mentionedBot && effectiveBotQQ ? `[CQ:at,qq=${effectiveBotQQ}] ` : '';
  const mergedText = normalizeText(merged.text || '');
  const selectedImageUrl = Array.isArray(merged.imageUrls) && merged.imageUrls.length
    ? merged.imageUrls[merged.imageUrls.length - 1]
    : null;
  const imageRefMap = merged.imageRefMap && typeof merged.imageRefMap === 'object'
    ? { ...merged.imageRefMap }
    : {};
  const selectedImageRef = normalizeText(imageRefMap[selectedImageUrl] || '');
  const rawParts = [];
  if (atPrefix) rawParts.push(atPrefix.trimEnd());
  rawParts.push(...buildReplyContextPromptLines(merged.replyContext));
  rawParts.push(...buildForwardPromptLines(merged.forwardSummaryText, merged.forwardImageUrls));
  if (mergedText) rawParts.push(mergedText);
  if (Array.isArray(merged.qqCardUrls) && merged.qqCardUrls.length) {
    for (const url of uniqueStrings(merged.qqCardUrls.map((item) => normalizeText(item)).filter(Boolean))) {
      rawParts.push(appendPromptLine('[分享链接]', url));
    }
  }
  if (selectedImageUrl) rawParts.push(`[CQ:image,url=${selectedImageUrl}]`);
  const rawMessage = rawParts.join('\n').trim();

  return {
    ...baseMsg,
    raw_message: rawMessage,
    message: merged.message,
    message_id: String(baseMsg?.message_id || merged.sourceMessageIds?.[0] || '').trim() || baseMsg?.message_id,
    __continuousMessageMeta: {
      sessionKey: merged.sessionKey,
      firstTimestamp: merged.firstTimestamp,
      lastTimestamp: merged.lastTimestamp,
      sourceMessageIds: merged.sourceMessageIds,
      mentionedBot: Boolean(merged.mentionedBot),
      imageUrls: merged.imageUrls,
      imageRefMap,
      selectedImageUrl,
      selectedImageRef,
      flushReason: merged.flushReason,
      replyMessageId: normalizeText(merged.replyMessageId),
      replyContext: cloneReplyContext(merged.replyContext),
      forwardIds: Array.isArray(merged.forwardIds) ? merged.forwardIds.slice() : [],
      forwardSummaryText: normalizeText(merged.forwardSummaryText || ''),
      forwardImageUrls: Array.isArray(merged.forwardImageUrls) ? merged.forwardImageUrls.slice() : [],
      forwardImageRefMap: merged.forwardImageRefMap && typeof merged.forwardImageRefMap === 'object'
        ? { ...merged.forwardImageRefMap }
        : {},
      qqCardUrls: Array.isArray(merged.qqCardUrls) ? merged.qqCardUrls.slice() : [],
      expansionState: {
        reply: merged.replyContext ? 'resolved' : (merged.replyMessageId ? 'pending' : 'skipped'),
        forward: Array.isArray(merged.forwardIds) && merged.forwardIds.length ? 'pending' : 'skipped',
        card: Array.isArray(merged.qqCardUrls) && merged.qqCardUrls.length ? 'pending' : 'skipped'
      }
    }
  };
}

function buildMergedMessagePayload(entries = [], options = {}) {
  const texts = [];
  const imageUrls = [];
  const sourceMessageIds = [];
  let mentionedBot = false;
  let firstTimestamp = 0;
  let lastTimestamp = 0;
  let replyMessageId = '';
  let replyContext = null;
  const forwardIds = [];
  const qqCardUrls = [];
  const forwardSummaryTexts = [];
  const forwardImageUrls = [];
  const imageRefMap = {};
  const forwardImageRefMap = {};

  for (const entry of entries) {
    if (!entry) continue;
    if (entry.text) texts.push(entry.text);
    if (Array.isArray(entry.imageUrls)) imageUrls.push(...entry.imageUrls.filter(Boolean));
    if (entry.imageRefMap && typeof entry.imageRefMap === 'object') Object.assign(imageRefMap, entry.imageRefMap);
    if (entry.messageId) sourceMessageIds.push(String(entry.messageId));
    if (entry.mentionedBot) mentionedBot = true;
    if (!replyMessageId && entry.replyMessageId) replyMessageId = String(entry.replyMessageId);
    if (!replyContext && entry.replyContext && typeof entry.replyContext === 'object') {
      replyContext = cloneReplyContext(entry.replyContext);
    }
    if (Array.isArray(entry.forwardIds)) forwardIds.push(...entry.forwardIds.filter(Boolean));
    if (Array.isArray(entry.qqCardUrls)) qqCardUrls.push(...entry.qqCardUrls.filter(Boolean));
    if (entry.forwardSummaryText) forwardSummaryTexts.push(String(entry.forwardSummaryText));
    if (Array.isArray(entry.forwardImageUrls)) forwardImageUrls.push(...entry.forwardImageUrls.filter(Boolean));
    if (entry.forwardImageRefMap && typeof entry.forwardImageRefMap === 'object') Object.assign(forwardImageRefMap, entry.forwardImageRefMap);
    const currentTs = Number(entry.timestamp || 0) || Date.now();
    if (!firstTimestamp || currentTs < firstTimestamp) firstTimestamp = currentTs;
    if (!lastTimestamp || currentTs > lastTimestamp) lastTimestamp = currentTs;
  }

  const dedupedImages = [];
  const seenImages = new Set();
  for (const url of imageUrls) {
    if (!url || seenImages.has(url)) continue;
    seenImages.add(url);
    dedupedImages.push(url);
  }

  const text = texts.filter(Boolean).join('\n').trim();
  const message = [];
  if (text) message.push({ type: 'text', data: { text } });
  if (dedupedImages.length) {
    for (const url of dedupedImages) {
      message.push({ type: 'image', data: { url, file: url } });
    }
  }

  return {
    sessionKey: options.sessionKey || '',
    text,
    semanticText: stripSemanticClassifierNoise(text),
    message,
    imageUrls: dedupedImages,
    firstTimestamp,
    lastTimestamp,
    sourceMessageIds: Array.from(new Set(sourceMessageIds)),
    mentionedBot,
    replyMessageId,
    replyContext,
    forwardIds: Array.from(new Set(forwardIds)),
    forwardSummaryText: forwardSummaryTexts.filter(Boolean).join('\n').trim(),
    forwardImageUrls: Array.from(new Set(forwardImageUrls)),
    imageRefMap,
    forwardImageRefMap,
    qqCardUrls: Array.from(new Set(qqCardUrls))
  };
}

async function enrichEntryFromReply(entry, options = {}) {
  if (!config.CONTINUOUS_MESSAGE_REPLY_EXPANSION_ENABLED) return entry;
  const replyMessageId = normalizeText(entry.replyMessageId);
  if (!replyMessageId) return entry;
  try {
    const original = await getMessageByIdCached(replyMessageId, options);
    const senderName = senderNameFromMessage(original);
    const senderId = senderIdFromMessage(original);
    const qqCardLinksEnabled = options.qqCardLinksEnabled ?? config.CONTINUOUS_MESSAGE_QQ_CARD_LINKS_ENABLED;
    const originalParsed = collectMessageContent(original?.message || original?.data?.message || [], {
      ...options,
      qqCardLinksEnabled
    });
    const fallbackText = stripCqControlSegments(original?.raw_message || '');
    const originalCardUrls = qqCardLinksEnabled
      ? uniqueStrings([
        ...(Array.isArray(originalParsed.qqCardUrls) ? originalParsed.qqCardUrls : []),
        ...extractUrlsFromRawJsonSegments(original?.raw_message || '')
      ])
      : [];
    const fullText = appendCardUrlsToText(originalParsed.text || fallbackText, originalCardUrls, {
      qqCardLinksEnabled
    });
    entry.replyContext = {
      messageId: replyMessageId,
      senderId,
      senderName,
      origin: 'reply_quote',
      hasImage: Array.isArray(originalParsed.imageUrls) && originalParsed.imageUrls.length > 0,
      text: fullText,
      imageUrls: Array.isArray(originalParsed.imageUrls) ? originalParsed.imageUrls.slice() : [],
      imageRefMap: Array.isArray(originalParsed.imageUrls)
        ? await buildImageRefMap(originalParsed.imageUrls, {
            ...options,
            imageSource: 'reply',
            sourceMessageId: replyMessageId,
            userId: options.userId,
            userText: fullText
          })
        : {}
    };
    console.log('[continuous-message] reply expand success', {
      replyMessageId,
      senderName,
      hasText: Boolean(fullText),
      imageCount: Array.isArray(originalParsed.imageUrls) ? originalParsed.imageUrls.length : 0
    });
  } catch (error) {
    console.warn('[continuous-message] reply expand failed', {
      replyMessageId,
      error: error?.message || String(error || '')
    });
  }
  return entry;
}

async function enrichEntryFromForward(entry, options = {}) {
  if (!config.CONTINUOUS_MESSAGE_FORWARD_EXPANSION_ENABLED) return entry;
  const ids = Array.isArray(entry.forwardIds) ? entry.forwardIds.filter(Boolean) : [];
  if (!ids.length) return entry;
  const lines = [];
  const forwardImageUrls = [];
  for (const forwardId of ids) {
    try {
      const messages = await getForwardMessagesByIdCached(forwardId, options);
      let imageCount = 0;
      for (const node of messages) {
        const senderName = senderNameFromMessage(node?.sender || node);
        const parsed = textFromForwardNode(node?.message || node?.content || []);
        if (parsed.text) lines.push(`${senderName}: ${parsed.text}`);
        if (parsed.imageUrls.length) {
          imageCount += parsed.imageUrls.length;
          entry.imageUrls.push(...parsed.imageUrls);
          forwardImageUrls.push(...parsed.imageUrls);
        }
      }
      console.log('[continuous-message] forward expand success', {
        forwardId,
        nodeCount: messages.length,
        imageCount
      });
    } catch (error) {
      console.warn('[continuous-message] forward expand failed', {
        forwardId,
        error: error?.message || String(error || '')
      });
    }
  }
  if (lines.length) {
    entry.forwardSummaryText = lines.join('\n').trim();
    entry.text = [entry.forwardSummaryText, entry.text].filter(Boolean).join('\n').trim();
  }
  entry.forwardImageUrls = uniqueStrings(forwardImageUrls);
  entry.forwardImageRefMap = await buildImageRefMap(entry.forwardImageUrls, {
    ...options,
    imageSource: 'forward',
    sourceMessageId: Array.isArray(entry.forwardIds) ? entry.forwardIds.join(',') : '',
    userText: entry.forwardSummaryText || entry.text
  });
  return entry;
}

async function parseMessageEntry(msg = {}, options = {}) {
  const entry = cheapParseMessageEntry(msg, options);
  await resolveContinuousEntryDetails(entry, options);
  return entry;
}

function cheapParseMessageEntry(msg = {}, options = {}) {
  const rawText = String(msg?.raw_message || '');
  const qqCardLinksEnabled = options.qqCardLinksEnabled ?? config.CONTINUOUS_MESSAGE_QQ_CARD_LINKS_ENABLED;
  const extracted = collectMessageContent(msg?.message || [], {
    ...options,
    qqCardLinksEnabled
  });
  const fallbackText = stripCqControlSegments(rawText);
  const entry = {
    messageId: normalizeText(msg?.message_id),
    timestamp: Number(msg?.time || 0) > 0 ? Number(msg.time) * 1000 : Date.now(),
    text: extracted.text || fallbackText,
    imageUrls: [
      ...extracted.imageUrls,
      ...parseRawImageUrls(rawText)
    ],
    imageRefMap: {},
    replyMessageId: extracted.replyMessageId || parseRawReplyId(rawText),
    replyContext: null,
    forwardIds: extracted.forwardIds.length ? extracted.forwardIds : parseRawForwardIds(rawText),
    forwardSummaryText: '',
    forwardImageUrls: [],
    forwardImageRefMap: {},
    mentionedBot: Boolean(options.effectiveBotQQ) && String(rawText).includes(`[CQ:at,qq=${options.effectiveBotQQ}]`),
    qqCardUrls: qqCardLinksEnabled
      ? uniqueStrings([
        ...(Array.isArray(extracted.qqCardUrls) ? extracted.qqCardUrls : []),
        ...extractUrlsFromRawJsonSegments(rawText)
      ])
      : [],
    expansionState: {
      reply: extracted.replyMessageId || parseRawReplyId(rawText) ? 'pending' : 'skipped',
      forward: (extracted.forwardIds.length ? extracted.forwardIds : parseRawForwardIds(rawText)).length ? 'pending' : 'skipped',
      card: qqCardLinksEnabled ? 'pending' : 'skipped'
    }
  };

  const dedupedImages = [];
  const seenImages = new Set();
  for (const url of entry.imageUrls) {
    if (!url || seenImages.has(url)) continue;
    seenImages.add(url);
    dedupedImages.push(url);
  }
  entry.imageUrls = dedupedImages;
  return entry;
}

async function resolveContinuousEntryDetails(entry = {}, options = {}) {
  if (!entry.expansionState || typeof entry.expansionState !== 'object') {
    entry.expansionState = {
      reply: Array.isArray(entry.replyMessageId) ? 'pending' : (entry.replyMessageId ? 'pending' : 'skipped'),
      forward: Array.isArray(entry.forwardIds) && entry.forwardIds.length ? 'pending' : 'skipped',
      card: Array.isArray(entry.qqCardUrls) && entry.qqCardUrls.length ? 'pending' : 'skipped'
    };
  }
  const qqCardLinksEnabled = options.qqCardLinksEnabled ?? config.CONTINUOUS_MESSAGE_QQ_CARD_LINKS_ENABLED;
  if (options.resolveReply !== false) {
    await enrichEntryFromReply(entry, options);
    entry.expansionState.reply = entry.replyContext ? 'resolved' : (entry.replyMessageId ? 'failed' : 'skipped');
  }
  if (options.resolveForward === true) {
    await enrichEntryFromForward(entry, options);
    entry.expansionState.forward = Array.isArray(entry.forwardIds) && entry.forwardIds.length ? 'resolved' : 'skipped';
  }
  if (options.resolveCards !== false && qqCardLinksEnabled) {
    entry.text = appendCardUrlsToText(entry.text, entry.qqCardUrls || [], { qqCardLinksEnabled });
    entry.expansionState.card = Array.isArray(entry.qqCardUrls) && entry.qqCardUrls.length ? 'resolved' : 'skipped';
  }
  entry.imageRefMap = await buildImageRefMap(entry.imageUrls, {
    ...options,
    imageSource: 'current',
    sourceMessageId: entry.messageId,
    userText: entry.text
  });
  if (entry.replyContext && typeof entry.replyContext === 'object' && (!entry.replyContext.imageRefMap || Object.keys(entry.replyContext.imageRefMap).length === 0)) {
    entry.replyContext.imageRefMap = await buildImageRefMap(entry.replyContext.imageUrls, {
      ...options,
      imageSource: 'reply',
      sourceMessageId: entry.replyContext.messageId || entry.replyMessageId,
      userText: entry.replyContext.text || entry.text
    });
  }
  if (Array.isArray(entry.forwardImageUrls) && (!entry.forwardImageRefMap || Object.keys(entry.forwardImageRefMap).length === 0)) {
    entry.forwardImageRefMap = await buildImageRefMap(entry.forwardImageUrls, {
      ...options,
      imageSource: 'forward',
      sourceMessageId: Array.isArray(entry.forwardIds) ? entry.forwardIds.join(',') : '',
      userText: entry.forwardSummaryText || entry.text
    });
  }
  const selectedImageUrl = normalizeText(
    entry.selectedImageUrl
    || (Array.isArray(entry.imageUrls) && entry.imageUrls.length ? entry.imageUrls[entry.imageUrls.length - 1] : '')
  );
  if (selectedImageUrl || Object.prototype.hasOwnProperty.call(entry, 'selectedImageRef')) {
    entry.selectedImageUrl = selectedImageUrl || null;
    entry.selectedImageRef = selectedImageUrl
      ? normalizeText((entry.imageRefMap || {})[selectedImageUrl] || '')
      : '';
  }
  return entry;
}

function isCommandBypass(msg = {}, options = {}) {
  const rawText = String(msg?.raw_message || '');
  const botQQ = normalizeText(options.effectiveBotQQ);
  const clean = String(rawText || '')
    .replace(/\[CQ:reply,[^\]]*\]/gi, ' ')
    .replace(botQQ ? new RegExp(`\\[CQ:at,qq=${botQQ}\\]`, 'gi') : /^$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return false;
  if (/^\s*\/(?:meme|dailyshare|life)(?:\s|$)/i.test(clean)) return true;
  if (/^(任务状态|取消任务|结束任务|任务补充|任务继续)\b/i.test(clean)) return true;
  return false;
}

function hasMeaningfulContinuousText(text = '') {
  const lines = String(text || '')
    .split(/\n+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.some((line) => line !== '[图片]');
}

function buildSessionFollowupState(entries = []) {
  let hasAnchor = false;
  let hasMeaningfulText = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if ((Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0) || normalizeText(entry.replyMessageId)) {
      hasAnchor = true;
    }
    if (!hasMeaningfulText && hasMeaningfulContinuousText(entry.text)) {
      hasMeaningfulText = true;
    }
    if (hasAnchor && hasMeaningfulText) break;
  }
  return {
    hasAnchor,
    hasMeaningfulText,
    awaitingFollowup: hasAnchor && !hasMeaningfulText
  };
}

function refreshSessionFollowupState(session = {}) {
  const nextState = buildSessionFollowupState(session.entries);
  session.awaitingFollowup = nextState.awaitingFollowup;
  return nextState;
}

function createContinuousMessagePreprocessor(options = {}) {
  const debounceMs = clampDebounceMs(
    options.debounceMs ?? config.CONTINUOUS_MESSAGE_DEBOUNCE_MS,
    2000
  );
  const atBotDebounceMs = clampDebounceMs(
    options.atBotDebounceMs ?? config.CONTINUOUS_MESSAGE_AT_BOT_DEBOUNCE_MS,
    2000
  );
  const privateDebounceMs = clampDebounceMs(
    options.privateDebounceMs ?? config.CONTINUOUS_MESSAGE_PRIVATE_DEBOUNCE_MS ?? 5000,
    5000
  );
  const maxHoldMs = clampDebounceMs(
    options.maxHoldMs ?? config.CONTINUOUS_MESSAGE_MAX_HOLD_MS,
    12000
  );
  const enabled = options.enabled ?? config.CONTINUOUS_MESSAGE_ENABLED;
  const sentenceWindowMs = clampDebounceMs(
    options.sentenceWindowMs ?? config.CONTINUOUS_MESSAGE_SENTENCE_WINDOW_MS,
    1200
  );
  const sentenceMinChars = Math.max(1, Number(options.sentenceMinChars ?? config.CONTINUOUS_MESSAGE_SENTENCE_MIN_CHARS) || 6);
  const sharedResolveOptions = {
    ensureCachedImageRef: typeof options.ensureCachedImageRef === 'function' ? options.ensureCachedImageRef : undefined,
    imageCacheTimeoutMs: options.imageCacheTimeoutMs,
    imageCacheMaxBytes: options.imageCacheMaxBytes,
    qqCardLinksEnabled: options.qqCardLinksEnabled
  };
  const sessions = new Map();
  const sessionActivityVersion = new Map();

  function buildSessionKey(msg = {}) {
    return `${normalizeText(msg?.group_id)}:${normalizeText(msg?.user_id)}`;
  }

  function bumpSessionActivityVersion(sessionKey = '') {
    const normalized = normalizeText(sessionKey);
    if (!normalized) return 0;
    const next = (Number(sessionActivityVersion.get(normalized) || 0) || 0) + 1;
    sessionActivityVersion.set(normalized, next);
    return next;
  }

  function clearTimer(session = {}) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  function getSessionDebounceMs(session = {}) {
    const baseDebounceMs = String(session.messageType || '').trim().toLowerCase() === 'private'
      ? privateDebounceMs
      : (session.mentionedBot === true ? atBotDebounceMs : debounceMs);
    if (session.awaitingFollowup === true) return maxHoldMs;
    return baseDebounceMs;
  }

  function scheduleFlush(sessionKey) {
    const session = sessions.get(sessionKey);
    if (!session) return;
    clearTimer(session);
    const elapsedMs = Math.max(0, Date.now() - Number(session.startedAt || Date.now()));
    const remainingHoldMs = Math.max(0, maxHoldMs - elapsedMs);
    const nextDelayMs = Math.min(getSessionDebounceMs(session), remainingHoldMs || getSessionDebounceMs(session));
    session.timer = setTimeout(() => {
      const current = sessions.get(sessionKey);
      if (!current) return;
      current.flushReason = remainingHoldMs <= getSessionDebounceMs(session) ? 'max_hold' : 'debounce';
      current.flushResolve();
    }, nextDelayMs);
  }

  function flushSession(sessionKey, reason = 'manual') {
    const session = sessions.get(sessionKey);
    if (!session) return;
    session.flushReason = reason;
    session.flushResolve();
  }

  async function handleMessage(msg = {}, context = {}) {
    if (!enabled) {
      return {
        mode: 'ready',
        effectiveMsg: msg,
        meta: msg?.__continuousMessageMeta || null
      };
    }

    const sessionKey = buildSessionKey(msg);
    if (!sessionKey || sessionKey === ':') {
      return {
        mode: 'ready',
        effectiveMsg: msg,
        meta: msg?.__continuousMessageMeta || null
      };
    }

    const activityVersion = bumpSessionActivityVersion(sessionKey);
    const effectiveBotQQ = normalizeText(context.effectiveBotQQ);
    const imageMemoryContext = {
      userId: normalizeText(msg?.user_id),
      groupId: normalizeText(msg?.group_id),
      sessionKey,
      messageId: normalizeText(msg?.message_id)
    };
    const entry = cheapParseMessageEntry(msg, {
      ...sharedResolveOptions,
      effectiveBotQQ,
      ...imageMemoryContext
    });
    const bypass = isCommandBypass(msg, { effectiveBotQQ });

    if (bypass && sessions.has(sessionKey)) {
      console.log('[continuous-message] command bypass flush', {
        sessionKey,
        messageId: entry.messageId
      });
      flushSession(sessionKey, 'command_bypass');
    }

    if (bypass) {
      await resolveContinuousEntryDetails(entry, {
        ...sharedResolveOptions,
        effectiveBotQQ,
        resolveReply: Boolean(entry.replyMessageId),
        resolveForward: Array.isArray(entry.forwardIds) && entry.forwardIds.length > 0,
        resolveCards: Array.isArray(entry.qqCardUrls) && entry.qqCardUrls.length > 0
      });
      return {
        mode: 'ready',
        effectiveMsg: msg,
        meta: {
          sessionKey,
          flushVersion: activityVersion,
          firstTimestamp: entry.timestamp,
          lastTimestamp: entry.timestamp,
          sourceMessageIds: entry.messageId ? [entry.messageId] : [],
          mentionedBot: entry.mentionedBot,
          imageUrls: entry.imageUrls,
          imageRefMap: entry.imageRefMap,
          selectedImageUrl: entry.imageUrls.length ? entry.imageUrls[entry.imageUrls.length - 1] : null,
          selectedImageRef: normalizeText((entry.imageRefMap || {})[entry.imageUrls.length ? entry.imageUrls[entry.imageUrls.length - 1] : ''] || ''),
          flushReason: 'command_bypass',
          replyMessageId: entry.replyMessageId || '',
          replyContext: cloneReplyContext(entry.replyContext),
          forwardIds: Array.isArray(entry.forwardIds) ? entry.forwardIds.slice() : [],
          forwardImageRefMap: entry.forwardImageRefMap && typeof entry.forwardImageRefMap === 'object'
            ? { ...entry.forwardImageRefMap }
            : {},
          qqCardUrls: Array.isArray(entry.qqCardUrls) ? entry.qqCardUrls.slice() : [],
          expansionState: { ...(entry.expansionState || {}) }
        }
      };
    }

    if (sessions.has(sessionKey)) {
      const session = sessions.get(sessionKey);
      session.entries.push(entry);
      session.mentionedBot = session.mentionedBot || entry.mentionedBot;
      session.activityVersion = activityVersion;
      refreshSessionFollowupState(session);
      scheduleFlush(sessionKey);
      console.log('[continuous-message] session append', {
        sessionKey,
        messageId: entry.messageId,
        size: session.entries.length,
        mentionedBot: session.mentionedBot === true,
        awaitingFollowup: session.awaitingFollowup === true
      });
      return {
        mode: 'deferred',
        effectiveMsg: null,
        meta: {
          sessionKey,
          flushVersion: session.activityVersion,
          firstTimestamp: session.entries[0]?.timestamp || entry.timestamp,
          lastTimestamp: entry.timestamp,
          sourceMessageIds: session.entries.map((item) => item.messageId).filter(Boolean),
          mentionedBot: session.entries.some((item) => item.mentionedBot),
          imageUrls: session.entries.flatMap((item) => item.imageUrls || []),
          imageRefMap: {},
          selectedImageUrl: null,
          selectedImageRef: '',
          flushReason: 'deferred',
          replyMessageId: session.entries.find((item) => item.replyMessageId)?.replyMessageId || '',
          replyContext: null,
          forwardIds: Array.from(new Set(session.entries.flatMap((item) => item.forwardIds || []).filter(Boolean))),
          forwardImageRefMap: {},
          qqCardUrls: Array.from(new Set(session.entries.flatMap((item) => item.qqCardUrls || []).filter(Boolean))),
          expansionState: {
            reply: session.entries.some((item) => item.replyMessageId) ? 'pending' : 'skipped',
            forward: session.entries.some((item) => Array.isArray(item.forwardIds) && item.forwardIds.length) ? 'pending' : 'skipped',
            card: session.entries.some((item) => Array.isArray(item.qqCardUrls) && item.qqCardUrls.length) ? 'pending' : 'skipped'
          }
        }
      };
    }

    let flushResolve;
    const flushPromise = new Promise((resolve) => {
      flushResolve = resolve;
    });

    const nextSession = {
      msg,
      entries: [entry],
      timer: null,
      flushResolve,
      flushReason: 'debounce',
      startedAt: Date.now(),
      mentionedBot: entry.mentionedBot === true,
      messageType: normalizeText(msg?.message_type).toLowerCase(),
      awaitingFollowup: false,
      activityVersion
    };
    refreshSessionFollowupState(nextSession);
    sessions.set(sessionKey, nextSession);
    scheduleFlush(sessionKey);
    console.log('[continuous-message] session start', {
      sessionKey,
      messageId: entry.messageId,
      mentionedBot: entry.mentionedBot === true,
      awaitingFollowup: nextSession.awaitingFollowup === true
    });

    await flushPromise;
    const session = sessions.get(sessionKey);
    if (!session) {
      return {
        mode: 'ready',
        effectiveMsg: msg,
        meta: msg?.__continuousMessageMeta || null
      };
    }

    const merged = buildMergedMessagePayload(session.entries, { sessionKey });
    merged.flushReason = session.flushReason || 'debounce';
    merged.flushVersion = session.activityVersion;
    merged.semanticScore = null;
    merged.semanticDecision = 'not_checked';
    if (!session.awaitingFollowup) {
      const sentenceDecision = seemsSentenceComplete(merged.semanticText || merged.text || '', {
        minChars: sentenceMinChars
      });
      merged.semanticDecision = sentenceDecision.complete ? 'complete' : sentenceDecision.reason;
      if (!sentenceDecision.complete) {
        const elapsedMs = Math.max(0, Date.now() - Number(session.startedAt || Date.now()));
        if (elapsedMs + sentenceWindowMs < maxHoldMs) {
          session.flushReason = 'sentence_window';
          clearTimer(session);
          await new Promise((resolve) => {
            session.flushResolve = resolve;
            session.timer = setTimeout(() => {
              const current = sessions.get(sessionKey);
              if (!current) return;
              current.flushReason = 'sentence_window';
              current.flushResolve();
            }, sentenceWindowMs);
          });
          const resumed = sessions.get(sessionKey);
          if (resumed) {
            sessions.delete(sessionKey);
            clearTimer(resumed);
            const resumedMerged = buildMergedMessagePayload(resumed.entries, { sessionKey });
            resumedMerged.flushReason = resumed.flushReason || 'sentence_window';
            resumedMerged.flushVersion = resumed.activityVersion;
            resumedMerged.semanticScore = null;
            resumedMerged.semanticDecision = 'max_hold_fallback';
            await resolveContinuousEntryDetails(resumedMerged, {
              ...sharedResolveOptions,
              effectiveBotQQ,
              ...imageMemoryContext,
              messageId: Array.isArray(resumedMerged.sourceMessageIds) ? resumedMerged.sourceMessageIds[0] : imageMemoryContext.messageId,
              resolveReply: Boolean(resumedMerged.replyMessageId),
              resolveForward: Array.isArray(resumedMerged.forwardIds) && resumedMerged.forwardIds.length > 0,
              resolveCards: Array.isArray(resumedMerged.qqCardUrls) && resumedMerged.qqCardUrls.length > 0
            });
            const resumedEffectiveMsg = normalizeMessageForDownstream(resumed.msg, resumedMerged, effectiveBotQQ);
            resumedEffectiveMsg.__continuousMessageMeta.flushVersion = resumedMerged.flushVersion;
            resumedEffectiveMsg.__continuousMessageMeta.semanticScore = resumedMerged.semanticScore;
            resumedEffectiveMsg.__continuousMessageMeta.semanticDecision = resumedMerged.semanticDecision;
            return {
              mode: 'ready',
              effectiveMsg: resumedEffectiveMsg,
              meta: resumedEffectiveMsg.__continuousMessageMeta
            };
          }
        }
      }
    }
    sessions.delete(sessionKey);
    clearTimer(session);
    await resolveContinuousEntryDetails(merged, {
      ...sharedResolveOptions,
      effectiveBotQQ,
      ...imageMemoryContext,
      messageId: Array.isArray(merged.sourceMessageIds) ? merged.sourceMessageIds[0] : imageMemoryContext.messageId,
      resolveReply: Boolean(merged.replyMessageId),
      resolveForward: Array.isArray(merged.forwardIds) && merged.forwardIds.length > 0,
      resolveCards: Array.isArray(merged.qqCardUrls) && merged.qqCardUrls.length > 0
    });
    const effectiveMsg = normalizeMessageForDownstream(session.msg, merged, effectiveBotQQ);
    effectiveMsg.__continuousMessageMeta.flushVersion = merged.flushVersion;
    effectiveMsg.__continuousMessageMeta.semanticScore = merged.semanticScore;
    effectiveMsg.__continuousMessageMeta.semanticDecision = merged.semanticDecision;
    console.log('[continuous-message] session flush', {
      sessionKey,
      count: session.entries.length,
      flushReason: merged.flushReason,
      sourceMessageIds: merged.sourceMessageIds
    });
    return {
      mode: 'ready',
      effectiveMsg,
      meta: effectiveMsg.__continuousMessageMeta
    };
  }

  return {
    getSessionDebounceMs,
    handleMessage,
    flushSession,
    buildSessionKey
  };
}

module.exports = {
  appendPromptLine,
  buildMergedMessagePayload,
  canonicalizeKnownShareUrl,
  clampDebounceMs,
  cheapParseMessageEntry,
  collectMessageContent,
  createContinuousMessagePreprocessor,
  extractTextAndImagesFromMessage,
  extractUrlsFromJsonPayload,
  extractUrlsFromRawJsonSegments,
  identifyCardPlatform,
  isCommandBypass,
  normalizeMessageForDownstream,
  parseMessageEntry,
  resolveContinuousEntryDetails,
  stripSemanticClassifierNoise,
  stripCqControlSegments
};
