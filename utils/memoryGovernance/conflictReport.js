const { evaluateMemoryQuality } = require('../memoryQuality');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeStatus(value = 'active') {
  const status = normalizeText(value).toLowerCase();
  return status || 'active';
}

function normalizeType(value = 'fact') {
  return normalizeText(value).toLowerCase() || 'fact';
}

function timestampOf(item = {}) {
  return Math.max(
    0,
    Number(item.updatedAt || 0) || 0,
    Number(item.lastConfirmedAt || 0) || 0,
    Number(item.createdAt || 0) || 0,
    Number(item.ts || 0) || 0
  );
}

function statusRank(item = {}) {
  const status = normalizeStatus(item.status);
  if (status === 'active') return 4;
  if (status === 'candidate') return 2;
  if (status === 'archived') return 0;
  return 1;
}

function sourceRank(item = {}) {
  const source = normalizeText(item.sourceKind || item.source || item.meta?.sourceKind || item.meta?.source).toLowerCase();
  if (source === 'explicit' || source === 'manual') return 4;
  if (source === 'journal' || source === 'daily_journal') return 3;
  if (source === 'migration' || source === 'legacy') return 2;
  if (source === 'extractor' || source === 'post_reply_learning') return 1;
  return 0;
}

function preferenceRank(item = {}) {
  const type = normalizeType(item.type || item.memoryKind);
  if (type === 'dislike') return 1;
  if (type === 'like') return 0.5;
  return 0;
}

function qualityScore(item = {}, options = {}) {
  try {
    return Number(evaluateMemoryQuality(item, options).score || 0) || 0;
  } catch (_) {
    return 0;
  }
}

function rankConflictItem(item = {}, options = {}) {
  const confidence = Math.max(0, Math.min(1, Number(item.confidence || item.meta?.confidence || 0) || 0));
  const importance = Math.max(0, Math.min(3, Number(item.importance || item.meta?.importance || 0) || 0));
  return (statusRank(item) * 1000)
    + (sourceRank(item) * 180)
    + (preferenceRank(item) * 80)
    + (qualityScore(item, options) * 70)
    + (confidence * 50)
    + (importance * 8)
    + (timestampOf(item) / 100000000000);
}

function conflictGroupKey(item = {}) {
  return normalizeText(item.conflictKey || item.meta?.conflictKey);
}

function summarizeMember(item = {}, winnerId = '', options = {}) {
  const id = normalizeText(item.id || item.nodeId);
  const rank = rankConflictItem(item, options);
  const isWinner = id && id === winnerId;
  const status = normalizeStatus(item.status);
  return {
    id,
    userId: normalizeText(item.userId),
    groupId: normalizeText(item.groupId),
    type: normalizeType(item.type || item.memoryKind),
    status,
    sourceKind: normalizeText(item.sourceKind || item.source || item.meta?.sourceKind),
    confidence: Number(item.confidence || item.meta?.confidence || 0) || 0,
    importance: Number(item.importance || item.meta?.importance || 0) || 0,
    updatedAt: timestampOf(item),
    rank,
    winner: isWinner,
    recommendedAction: isWinner
      ? 'keep_active'
      : (status === 'archived' ? 'keep_archived' : 'archive_superseded'),
    text: normalizeText(item.text || item.canonicalText || item.value || item.content).slice(0, 240)
  };
}

function buildConflictClusterReport(items = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || 50) || 50);
  const selected = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .filter((item) => !options.userId || normalizeText(item.userId) === normalizeText(options.userId));
  const groups = new Map();
  for (const item of selected) {
    const key = conflictGroupKey(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const clusters = [];
  for (const [conflictKey, members] of groups.entries()) {
    if (members.length < 2) continue;
    const ranked = members.slice().sort((a, b) => {
      const delta = rankConflictItem(b, options) - rankConflictItem(a, options);
      if (delta !== 0) return delta;
      return normalizeText(a.id || a.nodeId).localeCompare(normalizeText(b.id || b.nodeId));
    });
    const winner = ranked[0] || {};
    const winnerId = normalizeText(winner.id || winner.nodeId);
    const runnerUp = ranked[1] || {};
    const winnerRank = rankConflictItem(winner, options);
    const runnerUpRank = rankConflictItem(runnerUp, options);
    const closeCall = runnerUp && Math.abs(winnerRank - runnerUpRank) < Math.max(30, Number(options.closeCallMargin || 120) || 120);
    const allExplicit = ranked.filter((item) => normalizeStatus(item.status) !== 'archived').every((item) => sourceRank(item) >= 4);
    clusters.push({
      conflictKey,
      userId: normalizeText(winner.userId),
      groupId: normalizeText(winner.groupId),
      size: ranked.length,
      activeCount: ranked.filter((item) => normalizeStatus(item.status) === 'active').length,
      candidateCount: ranked.filter((item) => normalizeStatus(item.status) === 'candidate').length,
      archivedCount: ranked.filter((item) => normalizeStatus(item.status) === 'archived').length,
      winnerId,
      winnerText: normalizeText(winner.text || winner.canonicalText).slice(0, 240),
      confidence: closeCall || allExplicit ? 'needs_review' : 'strong',
      recommendation: closeCall || allExplicit ? 'manual_review' : 'archive_losers_keep_winner',
      members: ranked.map((item) => summarizeMember(item, winnerId, options))
    });
  }

  clusters.sort((a, b) => b.size - a.size || a.conflictKey.localeCompare(b.conflictKey));
  const limited = clusters.slice(0, limit);
  return {
    ok: true,
    scanned: selected.length,
    clusters: limited.length,
    totalClusters: clusters.length,
    needsReview: clusters.filter((item) => item.recommendation === 'manual_review').length,
    autoResolvable: clusters.filter((item) => item.recommendation === 'archive_losers_keep_winner').length,
    samples: limited
  };
}

module.exports = {
  buildConflictClusterReport,
  conflictGroupKey,
  rankConflictItem
};
