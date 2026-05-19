const config = require('../../config');
const {
  canonicalizeText,
  normalizeText,
  stableSortByScore
} = require('./helpers');
const { getJournalDocDay } = require('./journalDocs');
const { rowPassesMemoryFilter } = require('../lancedbMemoryStore');
const { lifecycleStatusOf } = require('./recallFilter');
const { applyLifecycleScore } = require('./profileLifecycle');
const {
  appendSelectionReason,
  buildRecallDiagnostics,
  getStrongSemanticThreshold
} = require('./queryDiagnostics');

function sourceLimit(source) {
  if (source === 'recent') return 2;
  if (source === 'profile') return 2;
  if (source === 'style' || source === 'jargon') return 1;
  if (source === 'journal') return 2;
  return 3;
}

function sourceLimitForFacet(source, facet = 'default') {
  const base = sourceLimit(source);
  const normalizedFacet = normalizeText(facet).toLowerCase();
  if (normalizedFacet === 'preference' || normalizedFacet === 'identity' || normalizedFacet === 'relationship') {
    if (source === 'profile') return Math.max(base, 3);
    if (source === 'personal') return Math.max(base, 3);
    if (source === 'recent' || source === 'task' || source === 'journal') return Math.min(base, 1);
  }
  if (normalizedFacet === 'continuity') {
    if (source === 'recent' || source === 'task' || source === 'journal') return Math.max(base, 3);
    if (source === 'profile') return 1;
  }
  if (normalizedFacet === 'task') {
    if (source === 'task') return Math.max(base, 4);
    if (source === 'recent' || source === 'journal') return Math.max(base, 3);
    if (source === 'profile') return 1;
  }
  if (normalizedFacet === 'journal') {
    if (source === 'journal') return Math.max(base, 4);
    if (source === 'profile') return 1;
  }
  return base;
}

function matchesFacetCandidate(facet, candidate = {}) {
  const fieldKey = normalizeText(candidate.fieldKey || candidate.semanticSlot || candidate.type).toLowerCase();
  const source = normalizeText(candidate.source).toLowerCase();
  if (facet === 'preference') return ['preference_like', 'preference_dislike', 'like', 'dislike', 'hobby', 'persona_summary_support', 'persona_impression_support'].includes(fieldKey);
  if (facet === 'identity') return ['identity', 'goal', 'boundary', 'hobby', 'personality', 'fact', 'persona_summary_support', 'persona_impression_support'].includes(fieldKey);
  if (facet === 'relationship') return ['relationship', 'relationship_tone', 'relationship_distance', 'relationship_salutation', 'relationship_reply_style', 'relationship_engagement', 'relationship_boundaries', 'style_pattern', 'persona_impression_support'].includes(fieldKey) || source === 'profile';
  if (facet === 'continuity') return source === 'recent' || source === 'journal' || source === 'task';
  if (facet === 'style') return ['style_pattern', 'style_avoid', 'group_jargon', 'bot_persona_tone', 'bot_persona_initiative', 'bot_persona_boundaries', 'bot_persona_playfulness', 'bot_persona_guardedness', 'bot_persona_verbosity', 'relationship_reply_style'].includes(fieldKey) || source === 'style' || source === 'jargon' || fieldKey === 'relationship';
  if (facet === 'task') return source === 'task';
  if (facet === 'group') return source === 'group';
  if (facet === 'journal') return source === 'journal';
  return true;
}

function semanticSlotForCandidate(candidate) {
  return normalizeText(candidate.semanticSlot || candidate.type || '').toLowerCase() || 'fact';
}

function protectStrongSemanticCandidates(items = [], topK = 8, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const threshold = getStrongSemanticThreshold(options);
  const limit = Math.max(1, Math.min(5, Number(options.strongSemanticProtectLimit || config.MEMORY_STRONG_SEMANTIC_PROTECT_LIMIT || 2) || 2));
  const protectedIds = new Set(
    list
      .filter((item) => Number(item.embedding || item.semantic || item.vectorScore || 0) >= threshold)
      .sort((a, b) => Number(b.embedding || b.semantic || b.vectorScore || 0) - Number(a.embedding || a.semantic || a.vectorScore || 0))
      .slice(0, Math.min(limit, Math.max(1, Number(topK) || 1)))
      .map((item) => normalizeText(item.id))
      .filter(Boolean)
  );
  if (!protectedIds.size) return list;
  const boost = Math.max(0.04, Number(options.strongSemanticBoost || config.MEMORY_STRONG_SEMANTIC_BOOST || 0.18) || 0.18);
  return list.map((item) => {
    if (!protectedIds.has(normalizeText(item.id))) return item;
    const selectionReason = appendSelectionReason(item.selectionReason, 'strong_semantic_protected');
    return {
      ...item,
      score: Number(item.score || 0) + boost,
      selectionReason,
      scoreParts: {
        ...(item.scoreParts || {}),
        strongSemanticBoost: boost
      },
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    };
  });
}

function boostJournalDaySummaryCompanions(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const threshold = getStrongSemanticThreshold(options);
  const strongSegmentDays = new Set(list
    .filter((item) => String(item.source || '').toLowerCase() === 'journal')
    .filter((item) => String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment')
    .filter((item) => Number(item.embedding || item.semantic || item.vectorScore || 0) >= threshold)
    .map((item) => getJournalDocDay(item))
    .filter(Boolean));
  if (!strongSegmentDays.size) return list;
  const boost = Math.max(0.04, Number(options.journalDaySummaryCompanionBoost || config.MEMORY_JOURNAL_DAY_SUMMARY_COMPANION_BOOST || 0.28) || 0.28);
  return list.map((item) => {
    if (String(item.source || '').toLowerCase() !== 'journal') return item;
    const day = getJournalDocDay(item);
    const isSegment = String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment';
    if (!day || isSegment || !strongSegmentDays.has(day)) return item;
    const selectionReason = appendSelectionReason(item.selectionReason, 'same_day_summary_companion');
    return {
      ...item,
      score: Number(item.score || 0) + boost,
      selectionReason,
      scoreParts: {
        ...(item.scoreParts || {}),
        daySummaryCompanionBoost: boost
      }
    };
  });
}

function applyConflictResolution(items = []) {
  const winners = new Map();
  for (const item of stableSortByScore(items).filter((candidate) => {
    const lifecycleStatus = lifecycleStatusOf(candidate);
    return lifecycleStatus !== 'stale' && lifecycleStatus !== 'suspect' && lifecycleStatus !== 'superseded';
  })) {
    const slot = `${item.userId || ''}|${item.scopeType || ''}|${semanticSlotForCandidate(item)}|${item.canonicalKey || canonicalizeText(item.text)}`;
    const existing = winners.get(slot);
    if (!existing) {
      winners.set(slot, item);
      continue;
    }
    const existingRank = (existing.status === 'active' ? 2 : 1) + (existing.sourceKind === 'explicit' ? 2 : 0);
    const currentRank = (item.status === 'active' ? 2 : 1) + (item.sourceKind === 'explicit' ? 2 : 0);
    if (currentRank > existingRank || (currentRank === existingRank && Number(item.score || 0) > Number(existing.score || 0))) {
      winners.set(slot, item);
    }
  }
  return Array.from(winners.values()).filter((item, index, list) => {
    const slot = semanticSlotForCandidate(item);
    if (slot !== 'nickname_preference' && slot !== 'like' && slot !== 'dislike' && slot !== 'preference') {
      return true;
    }
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    const sameKey = list.filter((candidate) => String(candidate.canonicalKey || canonicalizeText(candidate.text)) === canonical);
    if (sameKey.length <= 1) return true;
    const sorted = stableSortByScore(sameKey).sort((a, b) => {
      const aRank = (a.status === 'active' ? 2 : 1) + (a.sourceKind === 'explicit' ? 2 : 0) + (String(a.type || '').toLowerCase() === 'dislike' ? 1 : 0);
      const bRank = (b.status === 'active' ? 2 : 1) + (b.sourceKind === 'explicit' ? 2 : 0) + (String(b.type || '').toLowerCase() === 'dislike' ? 1 : 0);
      if (bRank !== aRank) return bRank - aRank;
      return Number(b.score || 0) - Number(a.score || 0);
    });
    return String(sorted[0]?.id || '') === String(item.id || '');
  });
}

function diversify(items = [], topK = 8, options = {}) {
  const selected = [];
  const perSource = new Map();
  const seenCanonical = new Set();
  const selectedJournalDays = new Set();
  const facet = normalizeText(options.facet || items.find((item) => item?.facet)?.facet || 'default').toLowerCase();
  const ranked = boostJournalDaySummaryCompanions(
    protectStrongSemanticCandidates(stableSortByScore(items.map((item) => applyLifecycleScore(item, options))), topK, options),
    options
  );
  for (const item of stableSortByScore(ranked)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (!canonical || seenCanonical.has(canonical)) continue;
    const source = String(item.source || 'personal');
    if ((perSource.get(source) || 0) >= sourceLimitForFacet(source, facet)) continue;
    if (source === 'journal') {
      const day = getJournalDocDay(item);
      const isSegment = String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment';
      const isStrongSemanticSegment = isSegment
        && Number(item.embedding || item.semantic || item.vectorScore || 0) >= getStrongSemanticThreshold(options);
      const hasDaySummary = day && ranked.some((candidate) => (
        getJournalDocDay(candidate) === day
        && String(candidate.source || '') === 'journal'
        && !String(candidate.type || '').includes('segment')
        && String(candidate.rollupLevel || '') !== 'segment'
      ));
      if (isSegment && hasDaySummary && !selectedJournalDays.has(day) && !isStrongSemanticSegment) continue;
      if (day && (!isSegment || isStrongSemanticSegment)) selectedJournalDays.add(day);
    }
    seenCanonical.add(canonical);
    perSource.set(source, (perSource.get(source) || 0) + 1);
    const selectionReason = appendSelectionReason(item.selectionReason, `facet_${facet || 'default'}_selected`);
    selected.push({
      ...item,
      selectionReason,
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    });
  }
  if (selected.length >= topK) return selected;
  for (const item of stableSortByScore(ranked)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    const selectionReason = appendSelectionReason(item.selectionReason, 'backfill_selected');
    selected.push({
      ...item,
      selectionReason,
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    });
  }
  return selected;
}

function splitStrictWeak(items = [], strictCap = 6, weakCap = 3) {
  const strictResults = [];
  const weakResults = [];
  for (const item of stableSortByScore(items)) {
    if (item.evidenceTier === 'strict' && strictResults.length < strictCap) {
      strictResults.push(item);
      continue;
    }
    if (item.evidenceTier !== 'strict' && weakResults.length < weakCap) {
      weakResults.push(item);
    }
  }
  return { strictResults, weakResults };
}

function diagnoseNoVisibleVectorCandidates(rows = [], candidates = [], context = {}, facet = 'default') {
  const rawRows = Array.isArray(rows) ? rows : [];
  if (rawRows.length === 0) return '';
  const localById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((item) => [normalizeText(item.id || item.nodeId), item])
    .filter(([key]) => key));
  const filter = context.filter || {};
  let missingLocal = 0;
  let scopeFiltered = 0;
  let facetFiltered = 0;
  for (const row of rawRows) {
    if (!rowPassesMemoryFilter(row, filter)) {
      scopeFiltered += 1;
      continue;
    }
    const local = localById.get(normalizeText(row.nodeId || row.id));
    if (!local) {
      missingLocal += 1;
      continue;
    }
    if (!matchesFacetCandidate(facet, local)) {
      facetFiltered += 1;
    }
  }
  if (scopeFiltered >= rawRows.length) return 'no_visible_candidates_scope_filtered';
  if (facetFiltered > 0 && facetFiltered + scopeFiltered + missingLocal >= rawRows.length) return 'no_visible_candidates_facet_filtered';
  if (missingLocal > 0 && missingLocal + scopeFiltered >= rawRows.length) return 'no_visible_candidates_missing_local';
  return 'no_visible_candidates';
}

module.exports = {
  applyConflictResolution,
  boostJournalDaySummaryCompanions,
  diagnoseNoVisibleVectorCandidates,
  diversify,
  matchesFacetCandidate,
  protectStrongSemanticCandidates,
  sourceLimitForFacet,
  splitStrictWeak
};
