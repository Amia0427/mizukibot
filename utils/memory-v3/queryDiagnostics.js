const config = require('../../config');
const { normalizeText, clampText } = require('./helpers');
const {
  loadEmbeddingIndex,
  getEmbeddingForCandidate
} = require('./embeddingIndex');

function getStrongSemanticThreshold(options = {}) {
  return Math.max(0.1, Number(options.strongSemanticMinScore || config.MEMORY_STRONG_SEMANTIC_MIN_SCORE || 0.82) || 0.82);
}

function appendSelectionReason(existing = '', reason = '') {
  const list = String(existing || '').split(',').map((item) => normalizeText(item)).filter(Boolean);
  if (reason && !list.includes(reason)) list.push(reason);
  return list.join(',');
}

function buildRecallDiagnostics(item = {}, selectionReason = '') {
  return {
    preRerankScore: Number(item.preRerankScore || 0) || 0,
    score: Number(item.score || 0) || 0,
    semantic: Number(item.embedding || item.semantic || 0) || 0,
    lexical: Number(item.lexical || 0) || 0,
    rerankScore: Number(item.rerankScore || 0) || 0,
    selectionReason: selectionReason || item.selectionReason || '',
    matchMode: normalizeText(item.matchMode)
  };
}

function buildDigest(items = [], maxChars = Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480) || 480) {
  const lines = (Array.isArray(items) ? items : [])
    .slice(0, 4)
    .map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 140)}`)
    .filter(Boolean);
  return clampText(lines.join('\n'), maxChars);
}

function buildLanceDbFallbackReason(diagnostics = {}, queryEmbedding = null, vectorStoreMode = 'local_jsonl') {
  if (diagnostics.enabled !== true) return 'read_disabled';
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return 'query_embedding_unavailable';
  if (diagnostics.ok !== true) return diagnostics.reason || 'search_failed';
  if (Number(diagnostics.rows || 0) <= 0) return 'empty_result';
  if (Number(diagnostics.vectorCandidates || 0) <= 0) return diagnostics.noVisibleReason || 'no_visible_candidates';
  if (vectorStoreMode !== 'lancedb') return `mode_${vectorStoreMode}`;
  return '';
}

function buildEmbeddingCoverageDiagnostics(candidates = []) {
  const total = Array.isArray(candidates) ? candidates.length : 0;
  const index = loadEmbeddingIndex();
  const ready = (Array.isArray(candidates) ? candidates : []).filter((candidate) => Boolean(getEmbeddingForCandidate(candidate, index))).length;
  const readyRatio = total > 0 ? ready / total : 0;
  const threshold = Math.max(0, Number(config.MEMORY_LANCEDB_LOW_COVERAGE_THRESHOLD || 0.05) || 0.05);
  return {
    total,
    ready,
    readyRatio,
    lowCoverage: total > 0 && readyRatio < threshold,
    threshold
  };
}

module.exports = {
  appendSelectionReason,
  buildDigest,
  buildEmbeddingCoverageDiagnostics,
  buildLanceDbFallbackReason,
  buildRecallDiagnostics,
  getStrongSemanticThreshold
};
