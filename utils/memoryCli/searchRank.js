const config = require('../../config');
const { getFacetPerSourceLimit, getFacetSourceWeights, shouldBiasToContinuity } = require('../recallHeuristics');
const { sanitizeText } = require('./commandParser');
const { sanitizePreviewText } = require('./text');

const SOURCE_PRIORITY = {
  recent: 0,
  personal: 1,
  task: 2,
  group: 3,
  style: 4,
  jargon: 5,
  profile: 6,
  journal: 7,
  image: 8
};

function rerankCandidates(candidates = [], queryFacet = 'default') {
  const sourceWeights = getFacetSourceWeights(queryFacet);
  return (Array.isArray(candidates) ? candidates : [])
    .map((item) => {
      const updatedAt = Number(item.updatedAt || 0) || 0;
      const ageHours = updatedAt > 0 ? Math.max(0, (Date.now() - updatedAt) / (60 * 60 * 1000)) : 9999;
      const recencyBoost = updatedAt > 0 ? Math.max(0.85, 1.25 - Math.min(ageHours / 168, 0.4)) : 1;
      const confidenceBoost = 0.88 + Math.min(0.2, Math.max(0, Number(item.confidence || 0)) * 0.2);
      const tierBoost = item.tier === 'S' ? 1.14 : item.tier === 'A' ? 1.08 : item.tier === 'C' ? 0.94 : 1;
      const sourceBoost = Number(sourceWeights[item.source] || 1) || 1;
      return {
        ...item,
        finalScore: (Number(item.score || 0) || 0.01) * sourceBoost * recencyBoost * confidenceBoost * tierBoost
      };
    })
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if ((SOURCE_PRIORITY[a.source] || 99) !== (SOURCE_PRIORITY[b.source] || 99)) {
        return (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
}

function dedupeAndDiversifyCandidates(candidates = [], limit = 8) {
  const seenText = new Set();
  const perSource = new Map();
  const results = [];
  const queryFacet = arguments[2] || 'default_continuity';
  const perSourceLimit = getFacetPerSourceLimit(queryFacet);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  const continuityCore = new Set(['recent', 'task', 'journal']);

  for (const item of Array.isArray(candidates) ? candidates : []) {
    const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
    if (!canonical) continue;
    if (seenText.has(canonical)) continue;
    const current = perSource.get(item.source) || 0;
    const maxPerSource = Math.max(1, Number(perSourceLimit[item.source] || 2) || 2);
    if (current >= maxPerSource) continue;
    seenText.add(canonical);
    perSource.set(item.source, current + 1);
    results.push(item);
    if (results.length >= limit) break;
  }

  if (continuityBias && results.length < limit) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (results.length >= limit) break;
      if (!continuityCore.has(item.source)) continue;
      if (results.find((row) => row.ref === item.ref)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      seenText.add(canonical);
      results.push(item);
    }
  }

  if (continuityBias && !results.some((item) => continuityCore.has(item.source))) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (!continuityCore.has(item.source)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      results.unshift(item);
      if (results.length > limit) results.pop();
      break;
    }
  }

  return results;
}

function buildRecallHints(results = []) {
  const maxChars = Math.max(120, Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480));
  const hints = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (hints.length >= 5) break;
    const prefix = item.source === 'recent'
      ? 'Recent continuity'
      : item.source === 'profile'
        ? 'Stable profile'
        : item.source === 'personal'
          ? 'Personal memory'
          : item.source === 'task'
            ? 'Task memory'
            : item.source === 'group'
              ? 'Group memory'
              : 'Journal memory';
    hints.push(`${prefix}: ${sanitizePreviewText(item.preview || item.text, 96)}`);
  }

  let total = 0;
  const digest = [];
  for (const hint of hints) {
    const nextTotal = total + hint.length + 1;
    if (nextTotal > maxChars) break;
    digest.push(hint);
    total = nextTotal;
  }
  return digest;
}

function trimSearchResultsForBudget(results = []) {
  const maxTotalChars = Math.max(800, Number(config.MEMORY_CLI_RESULT_TOTAL_CHARS || 2200));
  const output = [];
  let total = 0;
  let dropped = 0;

  for (const item of Array.isArray(results) ? results : []) {
    const preview = sanitizePreviewText(item.preview || item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
    const estimated = preview.length + String(item.title || '').length + 48;
    if (total + estimated > maxTotalChars) {
      dropped += 1;
      continue;
    }
    output.push({
      ref: item.ref,
      source: item.source,
      type: item.type,
      title: item.title,
      preview,
      text: preview,
      score: Number(item.finalScore || item.score || 0).toFixed(3),
      updatedAt: Number(item.updatedAt || 0) || 0,
      confidence: Number(item.confidence || 0) || 0,
      tier: String(item.tier || '').trim() || 'B',
      matchMode: String(item.matchMode || 'lexical').trim() || 'lexical',
      status: sanitizeText(item.status || '').toLowerCase() || 'active',
      sourceKind: sanitizeText(item.sourceKind || '').toLowerCase() || 'legacy',
      reason: sanitizePreviewText(item.reason || '', 120),
      id: sanitizeText(item.id || ''),
      memoryKind: sanitizeText(item.memoryKind || '').toLowerCase()
    });
    total += estimated;
  }

  return {
    results: output,
    outputChars: total,
    droppedResultCount: dropped
  };
}

module.exports = {
  buildRecallHints,
  dedupeAndDiversifyCandidates,
  rerankCandidates,
  trimSearchResultsForBudget
};
