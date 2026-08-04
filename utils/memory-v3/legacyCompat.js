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

module.exports = {
  mirrorLegacyMemories,
  retrieveLegacyMemories,
  retrieveLegacyMemoriesAsync
};
