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
  loadEmbeddingIndex,
  calcEmbeddingSimilarity
} = require('./embeddingIndex');
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
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
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
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const canonical = canonicalizeText(candidate.canonicalKey || text);
    const direct = canonical && rewrites.some((rewrite) => canonical.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const categoryBoost = categoryFacetBoost(candidate, facet);
    const score = ((lexical * 0.65) + direct + dateBoost + (recency * 0.08) + support + confidence + importance + categoryBoost) * sourceBoost;
    if (score <= 0.02 && lexical <= 0.01 && direct <= 0 && dateBoost <= 0) continue;
    scoped.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, score),
      lexical: Math.max(Number(candidate.lexical || 0) || 0, lexical),
      matchMode: Number(candidate.embedding || candidate.vectorScore || 0) > 0 ? 'hybrid' : 'lexical',
      scoreParts: {
        ...(candidate.scoreParts || {}),
        lexical,
        direct,
        dateBoost,
        recency,
        sourceBoost,
        categoryBoost
      }
    });
  }
  return stableSortByScore(scoped).slice(0, limit);
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
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const embeddingIndex = loadEmbeddingIndex();
  const useEmbedding = shouldUseRemoteEmbedding();
  let queryEmbedding = Array.isArray(options.queryEmbedding) ? options.queryEmbedding : null;
  if (!queryEmbedding && useEmbedding) {
    queryEmbedding = await requestEmbedding(rewrites.join('\n'));
  }
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
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const direct = candidate.canonicalKey && rewrites.some((rewrite) => candidate.canonicalKey.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const stabilityBoost = Math.min(0.24, Number(candidate.stabilityScore || 0) * 0.24);
    const strength = calcMemoryStrength(candidate, facet);
    const embedding = queryEmbedding
      ? calcEmbeddingSimilarity(queryEmbedding, candidate, embeddingIndex)
      : 0;
    const categoryBoost = categoryFacetBoost(candidate, facet);
    const score = ((lexical * lexicalWeight) + (embedding * semanticWeight) + direct + dateBoost + (recency * 0.08) + (strength.memoryStrength * 0.1) + support + confidence + importance + stabilityBoost + categoryBoost) * sourceBoost;
    const semanticOnly = embedding >= semanticMinScore && lexical < 0.04 && direct <= 0;
    if (score < minScore && !semanticOnly) continue;
    const matchMode = embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical';
    scored.push({
      ...candidate,
      score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
      lexical,
      embedding,
      matchMode,
      scoreParts: {
        lexical,
        embedding,
        direct,
        dateBoost,
        recency,
        sourceBoost,
        categoryBoost
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
  buildLexicalCandidatePool,
  ensureTargetJournalCandidates,
  facetSourceWeight,
  isJournalTargetDayCandidate,
  scoreCandidates,
  scoreLocalCandidatePool
};
