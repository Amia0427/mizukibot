const config = require('../../config');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const {
  normalizeText,
  canonicalizeText,
  tokenize,
  cosineFromTokenSets,
  stableSortByScore,
  uniqueBy
} = require('./helpers');
const {
  getJournalDocDay
} = require('./journalDocs');
const {
  journalDateMatchBoost,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const {
  appendSelectionReason,
  buildRecallDiagnostics
} = require('./queryDiagnostics');
const {
  calcMemoryStrength,
  rewriteQuery
} = require('./queryPolicy');
const { matchesFacetCandidate } = require('./queryRanking');
const { candidateKey } = require('./queryCandidates');
const { categoryFacetBoost } = require('./categoryMetadata');
const {
  buildRecentFallbackCandidates,
  detectRecentRecallIntent,
  recentCandidateBonus,
  recentSourceBoost
} = require('./recentRecallPolicy');

function getEmbeddingIndex() {
  return require('./embeddingIndex');
}

function buildLexicalText(candidate = {}) {
  return [
    candidate.title,
    candidate.category,
    Array.isArray(candidate.tags) ? candidate.tags.join(' ') : candidate.tags,
    candidate.intent,
    candidate.type || candidate.memoryKind,
    candidate.fieldKey || candidate.semanticSlot,
    candidate.canonicalKey || canonicalizeText(candidate.text),
    candidate.text
  ].map(normalizeText).filter(Boolean).join(' ');
}

function countTokens(tokens = []) {
  const counts = new Map();
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function buildBm25Index(candidates = [], facet = 'default') {
  const docs = [];
  const df = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const tokens = tokenize(buildLexicalText(candidate));
    if (tokens.length === 0) continue;
    const tf = countTokens(tokens);
    docs.push({
      key: candidateKey(candidate),
      length: tokens.length,
      tf
    });
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
  }
  const avgDocLength = docs.length > 0
    ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
    : 1;
  return {
    docsByKey: new Map(docs.map((doc) => [doc.key, doc])),
    df,
    docCount: docs.length,
    avgDocLength: Math.max(1, avgDocLength)
  };
}

function calcBm25Score(queryTokens = [], candidate = {}, index = null, options = {}) {
  if (!index || !index.docCount) return 0;
  const key = candidateKey(candidate);
  const doc = index.docsByKey.get(key);
  if (!doc) return 0;
  const k1 = Math.max(0.1, Number(options.bm25K1 || config.MEMORY_BM25_K1 || 1.2) || 1.2);
  const b = Math.max(0, Math.min(1, Number(options.bm25B || config.MEMORY_BM25_B || 0.75) || 0.75));
  let score = 0;
  for (const token of uniqueBy(queryTokens, (item) => item)) {
    const tf = Number(doc.tf.get(token) || 0);
    if (tf <= 0) continue;
    const df = Math.max(0, Number(index.df.get(token) || 0) || 0);
    const idf = Math.log(1 + ((index.docCount - df + 0.5) / (df + 0.5)));
    const lengthNorm = 1 - b + (b * (doc.length / index.avgDocLength));
    score += idf * ((tf * (k1 + 1)) / (tf + (k1 * lengthNorm)));
  }
  return Math.max(0, score);
}

function normalizeBm25Score(score = 0) {
  const value = Math.max(0, Number(score || 0) || 0);
  if (value <= 0) return 0;
  return value / (value + 2);
}

function buildRankFusionSnapshot(groups = {}, limit = 5) {
  const max = Math.max(1, Number(limit || 5) || 5);
  const out = {};
  for (const [name, items] of Object.entries(groups || {})) {
    out[name] = (Array.isArray(items) ? items : [])
      .slice(0, max)
      .map((item, index) => ({
        rank: index + 1,
        id: item.id || item.nodeId || '',
        score: Number(item.score || 0) || 0,
        bm25: Number(item.bm25 || 0) || 0,
        lexical: Number(item.lexical || 0) || 0,
        semantic: Number(item.embedding || item.vectorScore || item.semantic || 0) || 0,
        rerankScore: Number(item.rerankScore || 0) || 0,
        matchMode: normalizeText(item.matchMode)
      }));
  }
  return out;
}

function rankFusionContributionWeight(groupName = '', options = {}) {
  const key = normalizeText(groupName).toLowerCase();
  if (key === 'vector') return Math.max(0, Number(options.vectorWeight || config.MEMORY_LANCEDB_RRF_VECTOR_WEIGHT || 1.18) || 1.18);
  if (key === 'bm25') return Math.max(0, Number(options.bm25Weight || config.MEMORY_BM25_RRF_WEIGHT || 1.08) || 1.08);
  if (key === 'fallback') return Math.max(0, Number(options.fallbackWeight || config.MEMORY_FALLBACK_RRF_WEIGHT || 0.92) || 0.92);
  return Math.max(0, Number(options.localWeight || config.MEMORY_LANCEDB_RRF_LOCAL_WEIGHT || 1) || 1);
}

function fuseRankedCandidateGroups(groups = {}, options = {}) {
  const rrfK = Math.max(1, Number(options.rrfK || config.MEMORY_V3_RRF_K || 50) || 50);
  const strongVectorThreshold = Math.max(0, Math.min(1, Number(options.strongVectorThreshold || config.MEMORY_LANCEDB_STRONG_VECTOR_THRESHOLD || 0.72) || 0.72));
  const strongVectorBoost = Math.max(0, Number(options.strongVectorBoost || config.MEMORY_LANCEDB_STRONG_VECTOR_BOOST || 0.08) || 0.08);
  const slots = new Map();

  function addGroup(items = [], groupName = 'local') {
    const weight = rankFusionContributionWeight(groupName, options);
    if (weight <= 0) return;
    stableSortByScore(items).forEach((item, index) => {
      const key = candidateKey(item);
      if (!key) return;
      const current = slots.get(key) || {
        item,
        rrfScore: 0,
        rrfRanks: {},
        rrfSources: new Set()
      };
      current.rrfScore += weight / (rrfK + index + 1);
      current.rrfRanks[groupName] = current.rrfRanks[groupName] || (index + 1);
      current.rrfSources.add(groupName);
      current.item = Number(item.score || 0) > Number(current.item.score || 0)
        ? { ...current.item, ...item }
        : { ...item, ...current.item };
      slots.set(key, current);
    });
  }

  for (const [groupName, items] of Object.entries(groups || {})) {
    addGroup(items, groupName);
  }

  return Array.from(slots.values())
    .map((entry) => ({
      ...entry.item,
      score: Number(entry.item.score || 0)
        + entry.rrfScore
        + (Number(entry.item.vectorScore || entry.item.embedding || 0) >= strongVectorThreshold ? strongVectorBoost : 0),
      rrfScore: entry.rrfScore,
      rrfSources: Array.from(entry.rrfSources),
      rrfRanks: entry.rrfRanks,
      localRank: entry.rrfRanks.local ?? entry.item.localRank,
      vectorRank: entry.rrfRanks.vector ?? entry.item.vectorRank,
      bm25Rank: entry.rrfRanks.bm25 ?? entry.item.bm25Rank,
      fallbackRank: entry.rrfRanks.fallback ?? entry.item.fallbackRank,
      matchMode: entry.rrfSources.size > 1 ? 'hybrid_rrf' : entry.item.matchMode
    }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.id || '').localeCompare(String(b.id || '')));
}

function facetSourceWeight(facet, source) {
  const key = `${facet}:${source}`;
  const table = {
    'continuity:recent': 1.25,
    'continuity:journal': 0.95,
    'continuity:personal': 0.8,
    'preference:personal': 1.18,
    'preference:profile': 1.1,
    'identity:profile': 1.2,
    'identity:personal': 1.0,
    'task:task': 1.25,
    'group:group': 1.2,
    'style:style': 1.3,
    'style:jargon': 1.15,
    'journal:journal': 1.25,
    'relationship:profile': 1.25,
    'relationship:personal': 1.0
  };
  return Number(table[key] || 1);
}

function buildLexicalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const bm25Enabled = options.bm25Enabled !== false && config.MEMORY_BM25_ENABLED !== false;
  const bm25Index = bm25Enabled ? buildBm25Index(candidates, facet) : null;
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const recentIntent = detectRecentRecallIntent(query, options);
  const limit = Math.max(0, Math.min(
    512,
    Math.floor(Number(options.localCandidateLimit || config.MEMORY_LOCAL_CANDIDATE_LIMIT || 96) || 96)
  ));
  if (limit <= 0) return [];
  const scoped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexicalCosine = cosineFromTokenSets(queryTokens, docTokens);
    const bm25 = calcBm25Score(queryTokens, candidate, bm25Index, options);
    const bm25Normalized = normalizeBm25Score(bm25);
    const lexical = bm25Enabled ? Math.max(bm25Normalized, lexicalCosine * 0.75) : lexicalCosine;
    const canonical = canonicalizeText(candidate.canonicalKey || text);
    const direct = canonical && rewrites.some((rewrite) => canonical.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const sourceBoost = facetSourceWeight(facet, candidate.source) * recentSourceBoost(candidate, recentIntent);
    const categoryBoost = categoryFacetBoost(candidate, facet);
    const recentBonus = recentCandidateBonus(candidate, recentIntent, options);
    const score = ((lexical * 0.65) + direct + dateBoost + (recency * 0.08) + support + confidence + importance + categoryBoost + recentBonus) * sourceBoost;
    if (score <= 0.02 && lexical <= 0.01 && direct <= 0 && dateBoost <= 0 && recentBonus <= 0) continue;
    scoped.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, score),
      lexical: Math.max(Number(candidate.lexical || 0) || 0, lexical),
      bm25,
      bm25Normalized,
      lexicalCosine,
      matchMode: Number(candidate.embedding || candidate.vectorScore || 0) > 0 ? 'hybrid' : (bm25Enabled && bm25 > 0 ? 'bm25' : 'lexical'),
      scoreParts: {
        ...(candidate.scoreParts || {}),
        lexical,
        bm25,
        bm25Normalized,
        lexicalCosine,
        direct,
        dateBoost,
        recency,
        sourceBoost,
        categoryBoost,
        recentBonus
      }
    });
  }
  const existing = new Set(scoped.map((item) => candidateKey(item)).filter(Boolean));
  const fallbacks = buildRecentFallbackCandidates(candidates, recentIntent, options)
    .filter((item) => !existing.has(candidateKey(item)));
  return stableSortByScore(scoped.concat(fallbacks)).slice(0, limit);
}

function isJournalTargetDayCandidate(candidate = {}, targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return false;
  if (String(candidate.source || '').toLowerCase() !== 'journal') return false;
  const day = getJournalDocDay(candidate);
  return Boolean(day && targetDays.includes(day));
}

function applyJournalTargetDayPriority(items = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return items;
  const hardBoost = Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8);
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!isJournalTargetDayCandidate(item, targetDays)) return item;
    const score = Number(item.score || 0) || 0;
    return {
      ...item,
      score: score + hardBoost,
      journalTargetDayPriority: true,
      scoreParts: {
        ...(item.scoreParts || {}),
        targetDatePriorityBoost: hardBoost
      }
    };
  });
}

function ensureTargetJournalCandidates(items = [], allCandidates = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return Array.isArray(items) ? items : [];
  const existing = new Set((Array.isArray(items) ? items : []).map((item) => candidateKey(item)).filter(Boolean));
  const additions = [];
  for (const candidate of Array.isArray(allCandidates) ? allCandidates : []) {
    if (!isJournalTargetDayCandidate(candidate, targetDays)) continue;
    const key = candidateKey(candidate);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) + 8),
      lexical: Number(candidate.lexical || 0) || 0,
      embedding: Number(candidate.embedding || candidate.vectorScore || 0) || 0,
      matchMode: candidate.matchMode || 'date_fallback',
      journalTargetDayPriority: true,
      selectionReason: appendSelectionReason(candidate.selectionReason, 'target_day_fallback'),
      scoreParts: {
        ...(candidate.scoreParts || {}),
        targetDatePriorityBoost: Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8)
      }
    });
  }
  return stableSortByScore((Array.isArray(items) ? items : []).concat(additions));
}

function appendRerankTail(rerankedHead = [], rerankTail = []) {
  const head = Array.isArray(rerankedHead) ? rerankedHead : [];
  const tail = Array.isArray(rerankTail) ? rerankTail : [];
  if (!tail.length) return head;
  const headFloor = head.length > 0
    ? Math.min(...head.map((item) => Number(item.score || 0)).filter(Number.isFinite)) - 0.0001
    : null;
  if (!Number.isFinite(headFloor)) return head.concat(tail);
  return head.concat(tail.map((item) => ({
    ...item,
    preRerankScore: Number(item.score || item.finalScore || 0) || 0,
    score: Math.min(Number(item.score || 0) || 0, headFloor)
  })));
}

async function scoreCandidates(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const bm25Enabled = options.bm25Enabled !== false && config.MEMORY_BM25_ENABLED !== false;
  const bm25Index = bm25Enabled ? buildBm25Index(candidates, facet) : null;
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const recentIntent = detectRecentRecallIntent(query, options);
  const useEmbedding = shouldUseRemoteEmbedding();
  let queryEmbedding = Array.isArray(options.queryEmbedding) ? options.queryEmbedding : null;
  if (!queryEmbedding && useEmbedding) {
    queryEmbedding = await requestEmbedding(rewrites.join('\n'));
  }
  const useLocalEmbeddingIndex = queryEmbedding && config.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING !== true;
  const embeddingHelpers = useLocalEmbeddingIndex ? getEmbeddingIndex() : null;
  const embeddingIndex = embeddingHelpers ? embeddingHelpers.loadEmbeddingIndex() : null;
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const lexicalWeight = Math.max(0, Number(config.MEMORY_LEXICAL_RECALL_WEIGHT || 0.45) || 0.45);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticMinScore = Math.max(0.18, minScore * 1.5);
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexicalCosine = cosineFromTokenSets(queryTokens, docTokens);
    const bm25 = calcBm25Score(queryTokens, candidate, bm25Index, options);
    const bm25Normalized = normalizeBm25Score(bm25);
    const lexical = bm25Enabled ? Math.max(bm25Normalized, lexicalCosine * 0.75) : lexicalCosine;
    const direct = candidate.canonicalKey && rewrites.some((rewrite) => candidate.canonicalKey.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const sourceBoost = facetSourceWeight(facet, candidate.source) * recentSourceBoost(candidate, recentIntent);
    const stabilityBoost = Math.min(0.24, Number(candidate.stabilityScore || 0) * 0.24);
    const strength = calcMemoryStrength(candidate, facet);
    const embedding = embeddingHelpers
      ? embeddingHelpers.calcEmbeddingSimilarity(queryEmbedding, candidate, embeddingIndex)
      : 0;
    const categoryBoost = categoryFacetBoost(candidate, facet);
    const recentBonus = recentCandidateBonus(candidate, recentIntent, options);
    const score = ((lexical * lexicalWeight) + (embedding * semanticWeight) + direct + dateBoost + (recency * 0.08) + (strength.memoryStrength * 0.1) + support + confidence + importance + stabilityBoost + categoryBoost + recentBonus) * sourceBoost;
    const semanticOnly = embedding >= semanticMinScore && lexical < 0.04 && direct <= 0;
    if (score < minScore && !semanticOnly && recentBonus <= 0) continue;
    const matchMode = embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical';
    scored.push({
      ...candidate,
      score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
      lexical,
      bm25,
      bm25Normalized,
      lexicalCosine,
      embedding,
      matchMode,
      scoreParts: {
        lexical,
        bm25,
        bm25Normalized,
        lexicalCosine,
        embedding,
        direct,
        dateBoost,
        recency,
        sourceBoost,
        categoryBoost,
        recentBonus
      },
      decayScore: strength.decayScore,
      rehearsalBoost: strength.rehearsalBoost,
      continuityRecallBonus: strength.continuityRecallBonus,
      memoryStrength: strength.memoryStrength,
      forgettingReason: strength.forgettingReason,
      facet,
      diagnostics: {
        ...(candidate.diagnostics || {}),
        recall: buildRecallDiagnostics({
          ...candidate,
          score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
          lexical,
          embedding,
          matchMode
        }, semanticOnly ? 'semantic_only_candidate' : 'scored_candidate')
      }
    });
  }
  return scored;
}

async function scoreLocalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const base = Array.isArray(candidates) ? candidates : [];
  const scored = await scoreCandidates(base, query, facet, options);
  const scoredIds = new Set(scored.map((item) => candidateKey(item)).filter(Boolean));
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticOnly = base
    .filter((item) => !scoredIds.has(candidateKey(item)))
    .filter((item) => matchesFacetCandidate(facet, item) && Number(item.vectorScore || item.embedding || 0) > 0)
    .map((item) => {
      const embedding = Number(item.vectorScore || item.embedding || 0) || 0;
      const score = Math.max(Number(item.score || 0) || 0, minScore + (embedding * semanticWeight));
      return {
        ...item,
        score,
        embedding,
        matchMode: item.matchMode || 'lancedb',
        diagnostics: {
          ...(item.diagnostics || {}),
          recall: buildRecallDiagnostics({
            ...item,
            score,
            embedding,
            matchMode: item.matchMode || 'lancedb'
          }, 'lancedb_semantic_only_candidate')
        }
      };
    });
  return scored.concat(semanticOnly);
}

module.exports = {
  appendRerankTail,
  applyJournalTargetDayPriority,
  buildBm25Index,
  fuseRankedCandidateGroups,
  buildLexicalCandidatePool,
  buildRankFusionSnapshot,
  calcBm25Score,
  ensureTargetJournalCandidates,
  facetSourceWeight,
  isJournalTargetDayCandidate,
  normalizeBm25Score,
  scoreCandidates,
  scoreLocalCandidatePool
};
