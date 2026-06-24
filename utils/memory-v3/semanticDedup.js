const config = require('../../config');
const { normalizeText, stableSortByScore } = require('./helpers');
const {
  buildEmbeddingIdentity,
  getEmbeddingForCandidate,
  loadEmbeddingIndex
} = require('./embeddingIndex');
const { appendSelectionReason } = require('./queryDiagnostics');
const { cosineArray } = require('../vectorMemory');

const LONG_TERM_SOURCES = new Set(['personal', 'profile']);
const LONG_TERM_PREFERRED_FACETS = new Set(['preference', 'identity', 'relationship']);
const JOURNAL_PREFERRED_FACETS = new Set(['journal', 'continuity']);
const COLLAPSE_REASON = 'semantic_duplicate_collapsed';
const PAIR_DIAGNOSTIC_LIMIT = 10;

function normalizeSource(candidate = {}) {
  return normalizeText(candidate.source).toLowerCase();
}

function candidateId(candidate = {}) {
  return normalizeText(candidate.id || candidate.nodeId);
}

function isJournalCandidate(candidate = {}) {
  return normalizeSource(candidate) === 'journal';
}

function isLongTermCandidate(candidate = {}) {
  return LONG_TERM_SOURCES.has(normalizeSource(candidate));
}

function getCandidateScore(candidate = {}) {
  return Number(candidate.score || 0) || 0;
}

function buildDuplicateEvidence(loser = {}, similarity = 0) {
  return {
    id: candidateId(loser),
    source: normalizeSource(loser),
    type: normalizeText(loser.type || loser.memoryKind),
    text: normalizeText(loser.text),
    score: getCandidateScore(loser),
    similarity: Number(similarity || 0) || 0,
    reason: COLLAPSE_REASON
  };
}

function getFreshEmbeddingRow(candidate = {}, embeddingIndex) {
  const row = getEmbeddingForCandidate(candidate, embeddingIndex);
  if (!row) return null;
  const identity = buildEmbeddingIdentity(candidate);
  if (row.model !== identity.model) return null;
  if (Number(row.updatedAt || 0) !== Number(identity.updatedAt || 0)) return null;
  if (row.textHash === identity.textHash) return row;
  if (row.canonicalKey && row.canonicalKey === identity.canonicalKey) return row;
  if (row.nodeId && row.nodeId === identity.nodeId) return row;
  return null;
}

function pickWinner(left = {}, right = {}, facet = 'default') {
  const normalizedFacet = normalizeText(facet || 'default').toLowerCase();
  if (LONG_TERM_PREFERRED_FACETS.has(normalizedFacet)) {
    return isLongTermCandidate(left) ? [left, right] : [right, left];
  }
  if (JOURNAL_PREFERRED_FACETS.has(normalizedFacet)) {
    return isJournalCandidate(left) ? [left, right] : [right, left];
  }
  if (getCandidateScore(left) >= getCandidateScore(right)) return [left, right];
  return [right, left];
}

function buildDiagnostics(enabled, threshold, compared = 0, collapsed = 0, pairs = []) {
  return {
    enabled: enabled === true,
    threshold,
    compared,
    collapsed,
    pairs: pairs.slice(0, PAIR_DIAGNOSTIC_LIMIT)
  };
}

function pickNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function resolveOptions(options = {}) {
  const enabled = options.enabled ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED;
  const threshold = Math.max(0, Math.min(1, pickNumber(options.threshold ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_THRESHOLD, 0.9)));
  const maxPairs = Math.max(0, Math.floor(pickNumber(options.maxPairs ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_MAX_PAIRS, 128)));
  return {
    enabled: enabled !== false,
    threshold,
    maxPairs,
    facet: normalizeText(options.facet || 'default').toLowerCase() || 'default',
    embeddingIndex: options.embeddingIndex || null
  };
}

function collapseJournalLongTermSemanticDuplicates(items = [], options = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const resolved = resolveOptions(options);
  if (!resolved.enabled || resolved.maxPairs <= 0 || list.length <= 1) {
    return {
      items: list,
      diagnostics: buildDiagnostics(resolved.enabled, resolved.threshold)
    };
  }

  const journal = stableSortByScore(list.filter(isJournalCandidate));
  const longTerm = stableSortByScore(list.filter(isLongTermCandidate));
  if (!journal.length || !longTerm.length) {
    return {
      items: list,
      diagnostics: buildDiagnostics(true, resolved.threshold)
    };
  }

  const embeddingIndex = resolved.embeddingIndex || loadEmbeddingIndex();
  const rowsById = new Map();
  const readyCandidates = journal.concat(longTerm).filter((candidate) => {
    const row = getFreshEmbeddingRow(candidate, embeddingIndex);
    if (!row) return false;
    rowsById.set(candidateId(candidate), row);
    return true;
  });
  if (readyCandidates.length <= 1) {
    return {
      items: list,
      diagnostics: buildDiagnostics(true, resolved.threshold)
    };
  }

  let compared = 0;
  const candidatePairs = [];
  for (const journalItem of journal) {
    const journalRow = rowsById.get(candidateId(journalItem));
    if (!journalRow) continue;
    for (const longTermItem of longTerm) {
      if (compared >= resolved.maxPairs) break;
      const longTermRow = rowsById.get(candidateId(longTermItem));
      if (!longTermRow) continue;
      compared += 1;
      const similarity = Math.max(0, cosineArray(journalRow.embedding, longTermRow.embedding));
      candidatePairs.push({
        journal: journalItem,
        longTerm: longTermItem,
        similarity
      });
    }
    if (compared >= resolved.maxPairs) break;
  }

  const removed = new Set();
  const replacements = new Map();
  const diagnosticPairs = [];
  let collapsed = 0;
  const sortedPairs = candidatePairs
    .filter((pair) => pair.similarity >= resolved.threshold)
    .sort((a, b) => b.similarity - a.similarity);

  for (const pair of sortedPairs) {
    const journalId = candidateId(pair.journal);
    const longTermId = candidateId(pair.longTerm);
    if (!journalId || !longTermId || removed.has(journalId) || removed.has(longTermId)) continue;

    const [winner, loser] = pickWinner(pair.journal, pair.longTerm, resolved.facet);
    const winnerId = candidateId(winner);
    const loserId = candidateId(loser);
    if (!winnerId || !loserId) continue;

    const currentWinner = replacements.get(winnerId) || winner;
    const winnerWithEvidence = {
      ...currentWinner,
      duplicateEvidence: [
        ...(Array.isArray(currentWinner.duplicateEvidence) ? currentWinner.duplicateEvidence : []),
        buildDuplicateEvidence(loser, pair.similarity)
      ],
      selectionReason: appendSelectionReason(currentWinner.selectionReason, COLLAPSE_REASON)
    };
    replacements.set(winnerId, winnerWithEvidence);
    removed.add(loserId);
    collapsed += 1;
    if (diagnosticPairs.length < PAIR_DIAGNOSTIC_LIMIT) {
      diagnosticPairs.push({
        winnerId,
        loserId,
        winnerSource: normalizeSource(winner),
        loserSource: normalizeSource(loser),
        similarity: pair.similarity,
        reason: COLLAPSE_REASON
      });
    }
  }

  if (!removed.size) {
    return {
      items: list,
      diagnostics: buildDiagnostics(true, resolved.threshold, compared, 0)
    };
  }

  const collapsedItems = list
    .filter((item) => !removed.has(candidateId(item)))
    .map((item) => replacements.get(candidateId(item)) || item);

  return {
    items: collapsedItems,
    diagnostics: buildDiagnostics(true, resolved.threshold, compared, collapsed, diagnosticPairs)
  };
}

module.exports = {
  COLLAPSE_REASON,
  collapseJournalLongTermSemanticDuplicates
};
