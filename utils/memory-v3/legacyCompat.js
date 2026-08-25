'use strict';

const { normalizeText } = require('./helpers');

function getLegacyVectorMemory() {
  return require('../vectorMemory');
}

function retrieveLegacyMemories(userId, query, topK = 8, options = {}) {
  return getLegacyVectorMemory().retrieveUnifiedMemories(userId, query, topK, options);
}

async function retrieveLegacyMemoriesAsync(userId, query, topK = 8, options = {}) {
  return getLegacyVectorMemory().retrieveUnifiedMemoriesAsync(userId, query, topK, options);
}

async function mirrorLegacyMemories(items = []) {
  const candidates = (Array.isArray(items) ? items : []).filter((item) => normalizeText(item?.id));
  if (candidates.length === 0) return { ok: true, skipped: true, reason: 'no_items', ids: [] };
  try {
    const result = await getLegacyVectorMemory().addMemoryItemsBatchWithVectorBackfill(candidates, {
      skipPipeline: true,
      disableWriteRerank: true,
      reviewMode: 'off',
      recallVerification: false,
      materialize: false,
      syncLanceDb: false
    });
    return { ...result, ok: true };
  } catch (error) {
    return { ok: false, reason: 'legacy_mirror_failed', error: normalizeText(error?.message), ids: [] };
  }
}

function archiveLegacyMemory(memoryId, options = {}) {
  const id = normalizeText(memoryId);
  const userId = normalizeText(options.userId);
  if (!id) return { ok: false, reason: 'invalid_id' };
  const vectorMemory = getLegacyVectorMemory();
  const library = vectorMemory.loadLibrary();
  const item = library.items.find((candidate) => (
    normalizeText(candidate?.id) === id
    && normalizeText(candidate?.userId) === userId
  ));
  if (!item) return { ok: true, skipped: true, reason: 'not_found' };
  item.status = 'archived';
  item.updatedAt = Number(options.now || Date.now()) || Date.now();
  item.meta = {
    ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
    archivedReason: normalizeText(options.reason || 'user_forgotten')
  };
  vectorMemory.saveLibrary(library);
  return { ok: true, archived: true, id };
}

module.exports = {
  archiveLegacyMemory,
  mirrorLegacyMemories,
  retrieveLegacyMemories,
  retrieveLegacyMemoriesAsync
};
