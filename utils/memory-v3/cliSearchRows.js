const config = require('../../config');
const { getFacetPerSourceLimit } = require('../recallHeuristics');
const {
  canonicalizeText,
  normalizeText,
  tokenize
} = require('./helpers');
const { rerankMemoryCandidates } = require('../memoryReranker');
const { calcEmbeddingSimilarity } = require('./embeddingIndex');
const {
  journalDateMatchBoost,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const { resolveSourceCandidates } = require('./cliSearchScope');
const {
  categoryFacetBoost,
  deriveMemoryMetadata,
  matchesMemoryMetadataFilters
} = require('./categoryMetadata');

const SEARCH_EXPAND_SCORE_DEFAULT = 0.42;
const SEARCH_EXPAND_MIN_RATIO_DEFAULT = 0.5;

function nowMs() {
  return Date.now();
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function sanitizePreviewText(value, limit = 180) {
  const text = normalizeText(value);
  if (!text) return '';
  const maxChars = Math.max(24, Number(limit) || 180);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3).trim()}...` : text;
}

function overlapRatio(queryTokens = [], docTokens = []) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const docSet = new Set(docTokens);
  let hit = 0;
  for (const token of queryTokens) {
    if (docSet.has(token)) hit += 1;
  }
  return hit / Math.max(1, queryTokens.length);
}

function directMatchBoost(query = '', doc = {}) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  const normalizedText = normalizeText(doc.canonicalText || doc.text).toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText.includes(normalizedQuery)) return 0.3;
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const compactText = normalizedText.replace(/\s+/g, '');
  if (compactQuery && compactText.includes(compactQuery)) return 0.22;
  return 0;
}

function recencyBoost(updatedAt = 0) {
  if (!updatedAt) return 0;
  const ageHours = Math.max(0, (nowMs() - updatedAt) / (3600 * 1000));
  if (ageHours <= 24) return 0.22;
  if (ageHours <= 72) return 0.16;
  if (ageHours <= 24 * 14) return 0.08;
  if (ageHours <= 24 * 60) return 0.04;
  return 0;
}

function confidenceBoost(doc = {}) {
  return Math.min(0.12, Math.max(0, toSafeNumber(doc.confidence, 0)) * 0.12);
}

function tierBoost(doc = {}) {
  const tier = normalizeText(doc.tier).toUpperCase();
  if (tier === 'S') return 0.14;
  if (tier === 'A') return 0.1;
  if (tier === 'B') return 0.04;
  if (tier === 'C') return -0.03;
  return 0;
}

function scopeBoost(doc = {}, context = {}, queryFacet = 'default_continuity') {
  let boost = 0;
  if (normalizeText(doc.sessionKey) && normalizeText(context.sessionKey) && normalizeText(doc.sessionKey) === normalizeText(context.sessionKey)) {
    boost += 0.16;
  }
  if (normalizeText(doc.groupId) && normalizeText(context.groupId) && normalizeText(doc.groupId) === normalizeText(context.groupId)) {
    boost += 0.1;
  }
  if (queryFacet === 'recent_continuity' || queryFacet === 'task_or_plan' || queryFacet === 'default_continuity') {
    if (doc.source === 'recent') boost += 0.24;
    if (doc.source === 'task') boost += 0.18;
    if (doc.source === 'journal') boost += 0.12;
    if (doc.source === 'profile') boost -= 0.05;
  }
  if (queryFacet === 'preference' || queryFacet === 'identity' || queryFacet === 'relationship') {
    if (doc.source === 'profile') boost += 0.1;
    if (doc.source === 'personal') boost += 0.06;
  }
  if (queryFacet === 'group_context') {
    if (doc.source === 'group') boost += 0.12;
    if (doc.source === 'jargon') boost += 0.14;
  }
  return boost;
}

function scoreDoc(query = '', queryTokens = [], doc = {}, context = {}, queryFacet = 'default_continuity', scoring = {}) {
  const lexical = overlapRatio(queryTokens, normalizeArray(doc.tokens));
  const direct = directMatchBoost(query, doc);
  const dateBoost = journalDateMatchBoost(doc, resolveJournalTargetDays(query));
  const categoryBoost = categoryFacetBoost(doc, queryFacet);
  const embedding = scoring.queryEmbedding
    ? calcEmbeddingSimilarity(scoring.queryEmbedding, doc, scoring.embeddingIndex)
    : 0;
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const lexicalWeight = 0.72;
  const score = (lexical * 0.72)
    + (embedding * semanticWeight)
    + direct
    + dateBoost
    + recencyBoost(doc.updatedAt)
    + confidenceBoost(doc)
    + tierBoost(doc)
    + scopeBoost(doc, context, queryFacet)
    + categoryBoost;
  return {
    doc,
    score,
    lexical,
    direct,
    dateBoost,
    embedding,
    matchMode: embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical',
    scoreParts: {
      lexical,
      lexicalWeight,
      embedding,
      semanticWeight,
      direct,
      dateBoost,
      categoryBoost
    }
  };
}

function shouldExpandSelection(selected = [], limit = 8) {
  const topScore = Number(selected[0]?.score || 0);
  const expandScore = Number(config.MEMORY_CLI_SECONDARY_EXPAND_SCORE || SEARCH_EXPAND_SCORE_DEFAULT) || SEARCH_EXPAND_SCORE_DEFAULT;
  const expandMinRatio = Number(config.MEMORY_CLI_SECONDARY_EXPAND_MIN_RATIO || SEARCH_EXPAND_MIN_RATIO_DEFAULT) || SEARCH_EXPAND_MIN_RATIO_DEFAULT;
  const minSelected = Math.max(2, Math.ceil(Math.max(1, Number(limit) || 1) * expandMinRatio));
  return topScore < expandScore || selected.length < minSelected;
}

function resultRefForDoc(doc = {}) {
  if (doc.source === 'notebook' && doc.notebookRef) {
    return `mc_ref:notebook:${doc.notebookRef.docId}:${doc.notebookRef.chunkIndex}`;
  }
  return `mc_ref:${doc.source}:${doc.id}`;
}

function resultTypeForDoc(doc = {}) {
  if (doc.source === 'notebook') return 'notebook_doc';
  if (doc.source === 'recent') return 'recent_session';
  return doc.type || 'fact';
}

function trimPackedResults(rows = [], limit = 8) {
  const results = [];
  let outputChars = 0;
  let droppedResultCount = 0;
  const maxChars = Math.max(800, Number(config.MEMORY_CLI_RESULT_TOTAL_CHARS || 2200));
  for (const row of normalizeArray(rows)) {
    if (results.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const preview = sanitizePreviewText(doc.preview || doc.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
    const estimated = preview.length + String(doc.title || '').length + 48;
    if (outputChars + estimated > maxChars) {
      droppedResultCount += 1;
      continue;
    }
    results.push({
      ref: resultRefForDoc(doc),
      source: doc.source,
      type: resultTypeForDoc(doc),
      id: doc.source === 'notebook' && doc.notebookRef ? doc.notebookRef.docId : doc.id,
      title: doc.title || sanitizePreviewText(doc.text, 80),
      preview,
      text: preview,
      score: Number(row.score || 0).toFixed(3),
      updatedAt: doc.updatedAt || 0,
      confidence: doc.confidence || 0,
      tier: doc.tier || '',
      matchMode: row.matchMode || 'lexical',
      status: doc.status || 'active',
      sourceKind: doc.sourceKind || '',
      evidenceTier: doc.evidenceTier || '',
      fieldKey: doc.fieldKey || '',
      category: doc.category || deriveMemoryMetadata(doc).category,
      tags: Array.isArray(doc.tags) ? doc.tags : deriveMemoryMetadata(doc).tags,
      intent: doc.intent || deriveMemoryMetadata(doc).intent,
      privacyLevel: doc.privacyLevel || deriveMemoryMetadata(doc).privacyLevel
    });
    outputChars += estimated;
  }
  return { results, outputChars, droppedResultCount };
}

function digestForResults(rows = []) {
  const maxChars = Math.max(120, Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480));
  let total = 0;
  const output = [];
  for (const row of normalizeArray(rows).slice(0, 5)) {
    const doc = row.doc || {};
    const line = `[${doc.source}|${resultTypeForDoc(doc)}] ${sanitizePreviewText(doc.preview || doc.text, 120)}`;
    if (total + line.length + 1 > maxChars) break;
    output.push(line);
    total += line.length + 1;
  }
  return output;
}

function selectDiverseRows(rows = [], limit = 8, queryFacet = 'default_continuity') {
  const perSourceLimit = getFacetPerSourceLimit(queryFacet);
  const selected = [];
  const seenCanonical = new Set();
  const seenSourceCount = new Map();
  for (const row of normalizeArray(rows)) {
    if (selected.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const canonical = normalizeText(doc.canonicalText || doc.text).toLowerCase();
    if (!canonical || seenCanonical.has(canonical)) continue;
    const current = seenSourceCount.get(doc.source) || 0;
    const maxPerSource = Math.max(1, Number(perSourceLimit[doc.source] || 2) || 2);
    if (current >= maxPerSource) continue;
    seenCanonical.add(canonical);
    seenSourceCount.set(doc.source, current + 1);
    selected.push(row);
  }
  if (selected.length >= Math.max(1, Number(limit) || 1)) return selected;
  for (const row of normalizeArray(rows)) {
    if (selected.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const canonical = normalizeText(doc.canonicalText || doc.text).toLowerCase();
    if (!canonical || seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    selected.push(row);
  }
  return selected;
}

function sortRows(rows = []) {
  return normalizeArray(rows).slice().sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    if (Number(b.doc?.updatedAt || 0) !== Number(a.doc?.updatedAt || 0)) return Number(b.doc?.updatedAt || 0) - Number(a.doc?.updatedAt || 0);
    return String(a.doc?.id || '').localeCompare(String(b.doc?.id || ''));
  });
}

function gatherRowsForSources(snapshot, sources = [], query = '', limit = 8, context = {}, queryFacet = 'default_continuity', scoring = {}) {
  const queryTokens = tokenize(`${normalizeText(query)} ${canonicalizeText(query)}`);
  const rows = [];
  const candidateCounts = {};
  for (const source of normalizeArray(sources)) {
    const ids = resolveSourceCandidates(snapshot, source, context);
    candidateCounts[source] = ids.length;
    for (const id of ids) {
      const doc = snapshot.docsById.get(id);
      if (!doc || !doc.text) continue;
      if (!matchesMemoryMetadataFilters(doc, context)) continue;
      rows.push(scoreDoc(query, queryTokens, doc, context, queryFacet, scoring));
    }
  }
  return {
    rows: sortRows(rows),
    candidateCounts
  };
}

function applyJournalTargetDayPriorityToRows(rows = [], query = '') {
  const targetDays = resolveJournalTargetDays(query);
  if (!targetDays.length) return rows;
  const hardBoost = Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8);
  return normalizeArray(rows).map((row) => {
    const doc = row.doc || {};
    if (doc.source !== 'journal' || !targetDays.includes(String(doc.episodeDay || doc.title || '').trim())) return row;
    return {
      ...row,
      score: Number(row.score || 0) + hardBoost,
      journalTargetDayPriority: true,
      scoreParts: {
        ...(row.scoreParts || {}),
        targetDatePriorityBoost: hardBoost
      }
    };
  });
}

async function rerankRows(query = '', rows = [], context = {}) {
  const list = normalizeArray(rows);
  if (list.length < 2 || config.MEMORY_CLI_RERANK_ENABLED === false) return list;
  const candidates = list.map((row) => ({
    ...row.doc,
    score: row.score,
    finalScore: row.score,
    matchMode: row.matchMode,
    lexical: row.lexical,
    embedding: row.embedding,
    dateBoost: row.dateBoost
  }));
  const reranked = await rerankMemoryCandidates(query, candidates, {
    userId: context.userId,
    phase: 'memory_cli_fast',
    maxCandidates: config.MEMORY_RERANK_MAX_CANDIDATES
  });
  return normalizeArray(reranked).map((item) => ({
    doc: item,
    score: Number(item.score || item.finalScore || 0) || 0,
    lexical: Number(item.lexical || 0) || 0,
    direct: directMatchBoost(query, item),
    dateBoost: Number(item.dateBoost || item.scoreParts?.dateBoost || 0) || 0,
    embedding: Number(item.embedding || 0) || 0,
    rerankScore: Number(item.rerankScore || 0) || 0,
    matchMode: Number(item.rerankScore || 0) > 0
      ? (item.matchMode === 'semantic' ? 'semantic_rerank' : item.matchMode === 'hybrid' ? 'hybrid_rerank' : 'rerank')
      : (item.matchMode || 'lexical'),
    scoreParts: item.scoreParts || {}
  }));
}

function mergeCandidateCounts(base = {}, extra = {}) {
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    output[key] = (output[key] || 0) + (Number(value || 0) || 0);
  }
  return output;
}

function buildSearchResponse(selectedRows = [], candidateCounts = {}, queryFacet = 'default_continuity', fallbackUsed = false, limit = 8) {
  const packed = trimPackedResults(selectedRows, limit);
  const sourceCoverage = {};
  for (const item of packed.results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }
  return {
    results: packed.results,
    digest: digestForResults(selectedRows),
    sourceCoverage,
    queryFacet,
    candidateCounts,
    fallbackUsed,
    outputChars: packed.outputChars,
    recentUsed: Boolean(sourceCoverage.recent),
    droppedResultCount: packed.droppedResultCount
  };
}

module.exports = {
  applyJournalTargetDayPriorityToRows,
  buildSearchResponse,
  gatherRowsForSources,
  mergeCandidateCounts,
  rerankRows,
  selectDiverseRows,
  shouldExpandSelection,
  sortRows
};
