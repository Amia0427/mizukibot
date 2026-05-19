const config = require('../../config');
const {
  canonicalizeText,
  normalizeText
} = require('./helpers');
const { isMemoryNotRecallable } = require('./recallFilter');

function createEmbeddingNodes(deps = {}) {
  const { buildEmbeddingIdentity } = deps;

  function collectEmbeddingBackfillNodes() {
    const { loadMemoryNodes, loadEpisodeProjection } = require('./storage');
    const nodes = [];
    for (const node of loadMemoryNodes()) {
      if (!node || normalizeText(node.status).toLowerCase() === 'archived' || isMemoryNotRecallable(node)) continue;
      nodes.push(node);
    }
    const episodeProjection = loadEpisodeProjection();
    for (const [userId, entry] of Object.entries(episodeProjection.users || {})) {
      for (const episode of Array.isArray(entry?.items) ? entry.items : []) {
        if (isMemoryNotRecallable(episode)) continue;
        const text = normalizeText(episode.text);
        const eventId = normalizeText(episode.id);
        if (!text || !eventId) continue;
        const rollupLevel = normalizeText(episode.rollupLevel || episode.type || 'daily') || 'daily';
        if (rollupLevel === 'segment') continue;
        nodes.push({
          id: `episode:${eventId}`,
          source: 'journal',
          sourceKind: normalizeText(episode.sourceKind || 'journal'),
          type: 'episode',
          memoryKind: 'episode',
          scopeType: 'personal',
          userId: normalizeText(userId),
          ownerUserId: normalizeText(userId),
          fieldKey: 'episode',
          semanticSlot: 'episode',
          status: 'active',
          canonicalKey: normalizeText(episode.canonicalKey || episode.dedupeKey || canonicalizeText(text)).toLowerCase(),
          text,
          updatedAt: Number(episode.updatedAt || 0) || 0,
          confidence: Number(episode.confidence || 0) || 0.92,
          importance: Number(episode.importance || 0) || (rollupLevel === 'monthly' ? 1.2 : 1.0),
          evidenceCount: Math.max(1, Number(episode.evidenceCount || 1) || 1),
          evidenceTier: 'strict',
          rollupLevel,
          episodeDay: normalizeText(episode.episodeDay || episode.endDay || episode.startDay),
          startDay: normalizeText(episode.startDay),
          endDay: normalizeText(episode.endDay),
          yearMonth: normalizeText(episode.yearMonth),
          part: Math.max(0, Number(episode.part || 0) || 0),
          textKind: normalizeText(episode.textKind) || `journal_${rollupLevel}`,
          sourceCompleteness: normalizeText(episode.sourceCompleteness || 'summary'),
          sourceFile: normalizeText(episode.sourceFile)
        });
      }
    }
    if (config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED !== false) {
      const { buildDailyJournalDocsForAllUsers } = require('./journalDocs');
      for (const doc of buildDailyJournalDocsForAllUsers({ includeSegments: true })) {
        if (!doc || normalizeText(doc.status).toLowerCase() === 'archived' || isMemoryNotRecallable(doc)) continue;
        nodes.push(doc);
      }
    }
    return nodes;
  }

  function buildNodeMapByEmbeddingKey(nodes = []) {
    const map = new Map();
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const identity = buildEmbeddingIdentity(node);
      if (identity.key) map.set(identity.key, { node, identity });
    }
    return map;
  }

  function loadNodeMapByEmbeddingKey() {
    return buildNodeMapByEmbeddingKey(collectEmbeddingBackfillNodes());
  }

  return {
    buildNodeMapByEmbeddingKey,
    collectEmbeddingBackfillNodes,
    loadNodeMapByEmbeddingKey
  };
}

module.exports = {
  createEmbeddingNodes
};
