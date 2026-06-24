const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');
const { getAccessibleGroupIdsForUser } = require('./memoryScopeIndex');
const {
  formatDateInTz,
  getDatePartsInTz
} = require('./time');
const { cleanImageMemorySummary } = require('./imageMemorySummarySanitizer');

const DEFAULT_INDEX = Object.freeze({
  version: 1,
  images: {}
});
const CACHE_REF_PREFIX = 'cached-image://';
const IMAGE_RECALL_CUE_RE = /(?:图片|截图|照片|图像|战绩图|成绩图|分数图|结算图|谱面图|哪张图|几张图|什么图|发.{0,12}图|传.{0,12}图|给你.{0,12}图|打过.{0,8}(?:哪些|哪几|哪几首|什么|啥)?(?:歌|曲|谱)|(?:哪些|哪几|哪几首|什么|啥)(?:歌|曲|谱).{0,8}打过|打歌记录|音游记录|\bimage\b|\bphoto\b|\bscreenshot\b|\bscore\b|\bresult\b)/i;
const SELF_SENT_IMAGE_RE = /(?:(?:我|俺|咱|我们).{0,18}(?:发|传|贴|给你|给妳|发过|发了)|(?:发给你|发给妳|传给你|传给妳))/i;
const SCORE_IMAGE_RE = /(?:战绩|成绩|分数|结算|谱面|音游|打歌|\bscore\b|\bresult\b)/i;
const EARLY_MORNING_PREV_DAY_HOUR = 4;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSummaryText(value = '') {
  return cleanImageMemorySummary(value).summary;
}

function normalizeId(value = '') {
  return normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160);
}

function buildCacheRef(cacheKey = '') {
  const normalized = normalizeId(cacheKey);
  return normalized ? `${CACHE_REF_PREFIX}${normalized}` : '';
}

function parseCacheRef(value = '') {
  const text = normalizeText(value);
  if (!text.startsWith(CACHE_REF_PREFIX)) return '';
  return normalizeId(text.slice(CACHE_REF_PREFIX.length));
}

function normalizeTimestamp(value = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

function normalizeOptionalTimestamp(value = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeDate(value = null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function normalizeDay(value = '') {
  const day = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

function shiftDay(day = '', offsetDays = 0) {
  const normalized = normalizeDay(day);
  if (!normalized) return '';
  const [year, month, date] = normalized.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + Number(offsetDays || 0));
  return utc.toISOString().slice(0, 10);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function isImageRecallQuery(query = '') {
  return IMAGE_RECALL_CUE_RE.test(normalizeText(query));
}

function isSelfSentImageRecallQuery(query = '') {
  const text = normalizeText(query);
  return isImageRecallQuery(text) && SELF_SENT_IMAGE_RE.test(text);
}

function resolveImageTargetDays(query = '', context = {}, options = {}) {
  const text = normalizeText(query);
  const explicitDays = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const now = normalizeImageSearchNow(context, options);
  const today = normalizeDay(options.today || context.today || context.journalToday)
    || formatDateInTz(now, config.TIMEZONE);
  const days = explicitDays.slice();
  if (/(?:大前天)/.test(text)) days.push(shiftDay(today, -3));
  if (/(?:前天|day before yesterday)/i.test(text)) days.push(shiftDay(today, -2));
  if (/(?:昨天|昨日|yesterday)/i.test(text)) days.push(shiftDay(today, -1));
  if (/(?:今天|今日|today)/i.test(text)) {
    days.push(today);
    const hour = Number(getDatePartsInTz(now, config.TIMEZONE).hour || 0);
    if (hour >= 0 && hour < EARLY_MORNING_PREV_DAY_HOUR) {
      days.push(shiftDay(today, -1));
    }
  }
  return uniqueStrings(days.map(normalizeDay));
}

function normalizeImageSearchNow(context = {}, options = {}) {
  return normalizeDate(options.now || context.now || context.journalNow || context.timestamp || context.ts);
}

function getIndexFile() {
  return config.IMAGE_MEMORY_INDEX_FILE || path.join(config.DATA_DIR, 'image_memory_index.json');
}

function normalizeObservation(input = {}) {
  const observedAt = normalizeTimestamp(input.observedAt || input.timestamp || input.createdAt);
  const observation = {
    observedAt,
    source: normalizeText(input.source || 'message') || 'message',
    userId: normalizeId(input.userId),
    groupId: normalizeId(input.groupId),
    sessionKey: normalizeText(input.sessionKey),
    messageId: normalizeText(input.messageId),
    sourceMessageId: normalizeText(input.sourceMessageId),
    imageSource: normalizeText(input.imageSource),
    label: normalizeText(input.label),
    userText: normalizeText(input.userText || input.text || input.cleanText),
    summary: normalizeSummaryText(input.summary),
    ocrText: normalizeText(input.ocrText || input.visibleText)
  };
  return Object.fromEntries(Object.entries(observation).filter(([, value]) => value !== '' && value !== 0));
}

function normalizeDiagnosticObject(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === '' || value === 0) continue;
    if (Array.isArray(value)) continue;
    if (typeof value === 'object') {
      const nested = normalizeDiagnosticObject(value);
      if (nested) output[key] = nested;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) output[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    output[key] = normalizeText(value).slice(0, 800);
  }
  return Object.keys(output).length > 0 ? output : null;
}

function normalizeVisualSummaryState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const state = {
    status: normalizeText(input.status).slice(0, 40),
    failureCount: Math.max(0, Math.floor(Number(input.failureCount || 0) || 0)),
    lastAttemptAt: normalizeOptionalTimestamp(input.lastAttemptAt),
    lastFailedAt: normalizeOptionalTimestamp(input.lastFailedAt),
    nextRetryAt: normalizeOptionalTimestamp(input.nextRetryAt || input.cooldownUntil),
    reason: normalizeText(input.reason).slice(0, 160),
    errorClass: normalizeText(input.errorClass).slice(0, 80),
    model: normalizeText(input.model).slice(0, 160),
    apiBaseUrl: normalizeText(input.apiBaseUrl).slice(0, 240),
    requestShape: normalizeText(input.requestShape).slice(0, 80)
  };
  const requestDiagnostic = normalizeDiagnosticObject(input.requestDiagnostic);
  if (requestDiagnostic) state.requestDiagnostic = requestDiagnostic;
  const errorDiagnostic = normalizeDiagnosticObject(input.errorDiagnostic);
  if (errorDiagnostic) state.errorDiagnostic = errorDiagnostic;
  const compact = Object.fromEntries(Object.entries(state).filter(([, value]) => value !== '' && value !== 0));
  return Object.keys(compact).length > 0 ? compact : null;
}

function normalizeImageRecord(input = {}) {
  const cacheKey = normalizeId(input.cacheKey || parseCacheRef(input.imageRef || input.ref));
  if (!cacheKey) return null;
  const observations = Array.isArray(input.observations)
    ? input.observations.map(normalizeObservation).filter((item) => Object.keys(item).length > 0)
    : [];
  const createdAt = normalizeTimestamp(input.createdAt || input.firstSeenAt || observations[0]?.observedAt);
  const lastSeenAt = Math.max(
    createdAt,
    normalizeTimestamp(input.lastSeenAt || observations[observations.length - 1]?.observedAt || createdAt)
  );
  const record = {
    cacheKey,
    imageRef: normalizeText(input.imageRef || buildCacheRef(cacheKey)),
    mediaType: normalizeText(input.mediaType || 'image/jpeg') || 'image/jpeg',
    sourceUrl: normalizeText(input.sourceUrl),
    userId: normalizeId(input.userId),
    groupId: normalizeId(input.groupId),
    sessionKey: normalizeText(input.sessionKey),
    messageId: normalizeText(input.messageId),
    createdAt,
    lastSeenAt,
    userText: normalizeText(input.userText),
    summary: normalizeSummaryText(input.summary),
    ocrText: normalizeText(input.ocrText),
    visibleText: normalizeText(input.visibleText),
    observations
  };
  const visualSummaryState = normalizeVisualSummaryState(input.visualSummaryState);
  if (visualSummaryState) record.visualSummaryState = visualSummaryState;
  return record;
}

function normalizeIndex(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const images = input.images && typeof input.images === 'object' ? input.images : {};
  const next = { version: 1, images: {} };
  for (const [key, value] of Object.entries(images)) {
    const record = normalizeImageRecord({ ...(value || {}), cacheKey: key });
    if (record) next.images[record.cacheKey] = record;
  }
  return next;
}

function loadImageMemoryIndex() {
  return normalizeIndex(getJsonStore(getIndexFile(), {
    fallback: () => DEFAULT_INDEX
  }).read());
}

function saveImageMemoryIndex(index = {}) {
  const normalized = normalizeIndex(index);
  getJsonStore(getIndexFile(), {
    fallback: () => DEFAULT_INDEX
  }).replace(normalized, { flushNow: true });
  return normalized;
}

function mergeText(existing = '', incoming = '') {
  return normalizeText(incoming) || normalizeText(existing);
}

function mergeObservations(existing = [], incoming = null) {
  const maxItems = Math.max(1, Number(config.IMAGE_MEMORY_OBSERVATION_LIMIT || 20) || 20);
  const byKey = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const normalized = normalizeObservation(item);
    const key = [
      normalized.messageId || normalized.sourceMessageId || '',
      normalized.imageSource || '',
      normalized.label || '',
      normalized.observedAt || ''
    ].join('|');
    byKey.set(key, normalized);
  }
  if (incoming) {
    const normalized = normalizeObservation(incoming);
    const key = [
      normalized.messageId || normalized.sourceMessageId || '',
      normalized.imageSource || '',
      normalized.label || '',
      normalized.observedAt || ''
    ].join('|');
    byKey.set(key, normalized);
  }
  return Array.from(byKey.values())
    .sort((a, b) => Number(b.observedAt || 0) - Number(a.observedAt || 0))
    .slice(0, maxItems);
}

function upsertImageMemory(input = {}) {
  if (config.IMAGE_MEMORY_RECALL_ENABLED === false) {
    return { ok: false, skipped: true, reason: 'disabled', record: null };
  }
  const incoming = normalizeImageRecord(input);
  if (!incoming) return { ok: false, skipped: true, reason: 'missing_cache_key', record: null };
  const index = loadImageMemoryIndex();
  const existing = index.images[incoming.cacheKey] || null;
  const observation = normalizeObservation({
    ...input,
    userId: incoming.userId,
    groupId: incoming.groupId,
    sessionKey: incoming.sessionKey,
    messageId: incoming.messageId,
    userText: incoming.userText,
    summary: incoming.summary,
    ocrText: incoming.ocrText || incoming.visibleText
  });
  const observations = mergeObservations(existing?.observations || [], Object.keys(observation).length ? observation : null);
  const record = normalizeImageRecord({
    ...(existing || {}),
    ...incoming,
    sourceUrl: mergeText(existing?.sourceUrl, incoming.sourceUrl),
    mediaType: mergeText(existing?.mediaType, incoming.mediaType) || 'image/jpeg',
    userId: mergeText(existing?.userId, incoming.userId),
    groupId: mergeText(existing?.groupId, incoming.groupId),
    sessionKey: mergeText(existing?.sessionKey, incoming.sessionKey),
    messageId: mergeText(existing?.messageId, incoming.messageId),
    userText: mergeText(existing?.userText, incoming.userText),
    summary: mergeText(existing?.summary, incoming.summary),
    ocrText: mergeText(existing?.ocrText, incoming.ocrText),
    visibleText: mergeText(existing?.visibleText, incoming.visibleText),
    createdAt: existing?.createdAt || incoming.createdAt,
    lastSeenAt: Math.max(Number(existing?.lastSeenAt || 0), Number(incoming.lastSeenAt || Date.now())),
    observations
  });
  index.images[record.cacheKey] = record;
  saveImageMemoryIndex(index);
  return { ok: true, skipped: false, reason: '', record };
}

function getAccessibleImageGroupIds(userId = '', context = {}) {
  const groups = new Set();
  const currentGroupId = normalizeId(context.groupId);
  if (currentGroupId) groups.add(currentGroupId);
  for (const groupId of getAccessibleGroupIdsForUser(userId)) {
    const normalized = normalizeId(groupId);
    if (normalized) groups.add(normalized);
  }
  return groups;
}

function isImageScopeAccessible(scope = {}, userId = '', accessibleGroupIds = new Set()) {
  const groupId = normalizeId(scope.groupId);
  if (groupId) return accessibleGroupIds.has(groupId);
  const ownerUserId = normalizeId(scope.userId);
  return Boolean(ownerUserId && ownerUserId === userId);
}

function getVisibleImageObservations(record = {}, context = {}) {
  const observations = Array.isArray(record.observations) ? record.observations : [];
  const userId = normalizeId(context.userId);
  if (!userId) return observations;
  const accessibleGroupIds = getAccessibleImageGroupIds(userId, context);
  return observations.filter((item) => isImageScopeAccessible(item, userId, accessibleGroupIds));
}

function filterImageRecordForContext(record = {}, context = {}) {
  const userId = normalizeId(context.userId);
  if (!userId) return record;
  const accessibleGroupIds = getAccessibleImageGroupIds(userId, context);
  const recordScopeVisible = isImageScopeAccessible(record, userId, accessibleGroupIds);
  return {
    ...record,
    userId: recordScopeVisible ? record.userId : '',
    groupId: recordScopeVisible ? record.groupId : '',
    sessionKey: recordScopeVisible ? record.sessionKey : '',
    messageId: recordScopeVisible ? record.messageId : '',
    userText: recordScopeVisible ? record.userText : '',
    observations: getVisibleImageObservations(record, context)
  };
}

function buildSearchText(record = {}, context = {}) {
  const userId = normalizeId(context.userId);
  const accessibleGroupIds = userId ? getAccessibleImageGroupIds(userId, context) : new Set();
  const recordScopeVisible = !userId || isImageScopeAccessible(record, userId, accessibleGroupIds);
  const observations = getVisibleImageObservations(record, context);
  return [
    recordScopeVisible ? record.userText : '',
    record.summary,
    record.ocrText,
    record.visibleText,
    record.sourceUrl,
    recordScopeVisible ? record.messageId : '',
    recordScopeVisible ? record.sessionKey : '',
    ...observations.flatMap((item) => [item.userText, item.summary, item.ocrText, item.messageId, item.sourceMessageId, item.label, item.imageSource])
  ].map(normalizeText).filter(Boolean).join(' ');
}

function getVisibleImageTimestamps(record = {}, context = {}) {
  const visibleRecord = filterImageRecordForContext(record, context);
  const values = [
    visibleRecord.createdAt,
    visibleRecord.lastSeenAt,
    ...getVisibleImageObservations(record, context).map((item) => item.observedAt)
  ].map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? values : [Number(record.lastSeenAt || record.createdAt || 0)].filter(Boolean);
}

function getVisibleImageTimestampsBefore(record = {}, context = {}, maxTs = 0) {
  const upper = Number(maxTs || 0);
  return getVisibleImageTimestamps(record, context).filter((ts) => !upper || Number(ts || 0) <= upper);
}

function imageRecordMatchesTargetDays(record = {}, context = {}, targetDays = [], maxTs = 0) {
  const timestamps = getVisibleImageTimestampsBefore(record, context, maxTs);
  if (!timestamps.length) return false;
  if (!Array.isArray(targetDays) || targetDays.length === 0) return true;
  const daySet = new Set(targetDays.map(normalizeDay).filter(Boolean));
  if (daySet.size === 0) return true;
  return timestamps.some((ts) => {
    const day = formatDateInTz(new Date(Number(ts)), config.TIMEZONE);
    return daySet.has(day);
  });
}

function isSenderScopedImageRecord(record = {}, context = {}) {
  const userId = normalizeId(context.userId);
  if (!userId) return true;
  const visibleRecord = filterImageRecordForContext(record, context);
  if (normalizeId(visibleRecord.userId) === userId) return true;
  return getVisibleImageObservations(record, context).some((item) => normalizeId(item.userId) === userId);
}

function hasVisibleImageMarker(record = {}, context = {}, text = '') {
  const visibleRecord = filterImageRecordForContext(record, context);
  if (/\[图片\]|\[image\]|\[CQ:image/i.test(text)) return true;
  if (visibleRecord.imageRef || visibleRecord.sourceUrl) return true;
  return getVisibleImageObservations(record, context).some((item) => item.imageSource || item.label || /\[图片\]|\[image\]|\[CQ:image/i.test(item.userText || ''));
}

function imageMarkerStrength(record = {}, context = {}, text = '') {
  if (/\[图片\]|\[image\]|\[CQ:image/i.test(text)) return 1;
  if (getVisibleImageObservations(record, context).some((item) => item.imageSource || item.label || /\[图片\]|\[image\]|\[CQ:image/i.test(item.userText || ''))) {
    return 1;
  }
  const visibleRecord = filterImageRecordForContext(record, context);
  return visibleRecord.imageRef || visibleRecord.sourceUrl ? 0.55 : 0;
}

function scoreTextMatch(query = '', text = '') {
  const haystack = normalizeText(text).toLowerCase();
  const q = normalizeText(query).toLowerCase();
  if (!haystack || !q) return 0;
  if (haystack.includes(q)) return 1;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function canAccessImageRecord(record = {}, context = {}) {
  const userId = normalizeId(context.userId);
  if (!userId) return false;
  const accessibleGroupIds = getAccessibleImageGroupIds(userId, context);
  if (isImageScopeAccessible(record, userId, accessibleGroupIds)) return true;
  return getVisibleImageObservations(record, context).length > 0;
}

function imageBinPath(cacheKey = '') {
  return path.join(config.DATA_DIR, 'inbound_image_cache', `${normalizeId(cacheKey)}.bin`);
}

function imageExists(cacheKey = '') {
  try {
    return fs.existsSync(imageBinPath(cacheKey));
  } catch (_) {
    return false;
  }
}

function searchImageMemories(query = '', context = {}, options = {}) {
  if (config.IMAGE_MEMORY_RECALL_ENABLED === false) return [];
  const limit = Math.max(1, Math.min(20, Number(options.limit || 8) || 8));
  const imageIntent = isImageRecallQuery(query);
  const selfSentIntent = isSelfSentImageRecallQuery(query);
  const targetDays = resolveImageTargetDays(query, context, options);
  const searchNowTs = normalizeImageSearchNow(context, options).getTime();
  const index = loadImageMemoryIndex();
  return Object.values(index.images || {})
    .filter((record) => canAccessImageRecord(record, context))
    .filter((record) => imageRecordMatchesTargetDays(record, context, targetDays, searchNowTs))
    .filter((record) => !selfSentIntent || isSenderScopedImageRecord(record, context))
    .map((record) => {
      const visibleRecord = filterImageRecordForContext(record, context);
      const text = buildSearchText(record, context);
      const textScore = scoreTextMatch(query, text);
      const markerStrength = imageIntent ? imageMarkerStrength(record, context, text) : 0;
      const markerMatch = markerStrength > 0 || (imageIntent && hasVisibleImageMarker(record, context, text));
      const dayBoost = targetDays.length > 0 ? 0.18 : 0;
      const senderBoost = selfSentIntent && isSenderScopedImageRecord(record, context) ? 0.16 : 0;
      const scoreCueBoost = SCORE_IMAGE_RE.test(query) && markerMatch ? 0.08 : 0;
      const explicitMarkerBoost = markerStrength >= 1 ? 0.14 : 0;
      const fallbackScore = markerMatch ? (0.34 + dayBoost + senderBoost + scoreCueBoost + explicitMarkerBoost) : 0;
      return {
        ...visibleRecord,
        text,
        score: textScore > 0
          ? textScore + (record.summary ? 0.18 : 0) + (record.ocrText || record.visibleText ? 0.12 : 0) + dayBoost + senderBoost
          : fallbackScore,
        exists: imageExists(record.cacheKey)
      };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => {
      if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
      return Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0);
    })
    .slice(0, limit);
}

function openImageMemory(refOrKey = '', context = {}) {
  const cacheKey = normalizeId(parseCacheRef(refOrKey) || String(refOrKey || '').replace(/^mc_ref:image:/i, ''));
  if (!cacheKey) return null;
  const record = loadImageMemoryIndex().images[cacheKey] || null;
  if (!record || !canAccessImageRecord(record, context)) return null;
  const visibleRecord = filterImageRecordForContext(record, context);
  return {
    ...visibleRecord,
    imageRef: record.imageRef || buildCacheRef(cacheKey),
    exists: imageExists(cacheKey),
    binPath: imageBinPath(cacheKey)
  };
}

function recordVisualContextImages(visualContext = {}, context = {}) {
  const images = Array.isArray(visualContext?.images) ? visualContext.images : [];
  const caption = visualContext?.captionJson && typeof visualContext.captionJson === 'object'
    ? visualContext.captionJson
    : {};
  const ocrText = normalizeText([
    caption.ocr_text,
    caption.visible_text,
    Array.isArray(caption.images) ? caption.images.map((item) => item?.ocr_text || item?.visible_text || '').join(' ') : ''
  ].filter(Boolean).join(' '));
  const summary = normalizeText(visualContext.summary || caption.summary || visualContext.shortPersistSummary);
  const results = [];
  for (const image of images) {
    const cacheKey = parseCacheRef(image.url);
    if (!cacheKey) continue;
    results.push(upsertImageMemory({
      cacheKey,
      imageRef: image.url,
      mediaType: image.mediaType,
      userId: context.userId,
      groupId: context.groupId,
      sessionKey: context.sessionKey,
      messageId: context.messageId,
      imageSource: image.source,
      label: image.label,
      source: 'vision',
      userText: context.userText || visualContext.originalUserText,
      summary,
      ocrText
    }));
  }
  return results;
}

module.exports = {
  buildSearchText,
  canAccessImageRecord,
  isImageRecallQuery,
  loadImageMemoryIndex,
  openImageMemory,
  recordVisualContextImages,
  resolveImageTargetDays,
  saveImageMemoryIndex,
  searchImageMemories,
  upsertImageMemory
};
