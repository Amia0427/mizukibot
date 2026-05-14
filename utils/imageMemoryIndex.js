const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');
const { getAccessibleGroupIdsForUser } = require('./memoryScopeIndex');

const DEFAULT_INDEX = Object.freeze({
  version: 1,
  images: {}
});
const CACHE_REF_PREFIX = 'cached-image://';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
    summary: normalizeText(input.summary),
    ocrText: normalizeText(input.ocrText || input.visibleText)
  };
  return Object.fromEntries(Object.entries(observation).filter(([, value]) => value !== '' && value !== 0));
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
  return {
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
    summary: normalizeText(input.summary),
    ocrText: normalizeText(input.ocrText),
    visibleText: normalizeText(input.visibleText),
    observations
  };
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
  const index = loadImageMemoryIndex();
  return Object.values(index.images || {})
    .filter((record) => canAccessImageRecord(record, context))
    .map((record) => {
      const visibleRecord = filterImageRecordForContext(record, context);
      const text = buildSearchText(record, context);
      const textScore = scoreTextMatch(query, text);
      return {
        ...visibleRecord,
        text,
        score: textScore > 0
          ? textScore + (record.summary ? 0.18 : 0) + (record.ocrText || record.visibleText ? 0.12 : 0)
          : 0,
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
  loadImageMemoryIndex,
  openImageMemory,
  recordVisualContextImages,
  saveImageMemoryIndex,
  searchImageMemories,
  upsertImageMemory
};
