const config = require('../../config');
const { uniqueBy } = require('../memory-v3/helpers');

function getMemoryReranker() {
  try {
    return require('../memoryReranker');
  } catch (_) {
    return {};
  }
}

function shouldRerankCandidates(candidates = []) {
  if (config.PERSONA_WORLDBOOK_RERANK_ENABLED === false) return false;
  if (!Array.isArray(candidates) || candidates.length < 4) return false;
  const head = candidates.slice(0, Math.min(4, candidates.length));
  const top = Number(head[0]?.score || 0);
  const fourth = Number(head[head.length - 1]?.score || 0);
  return top <= 0 || fourth <= 0 || (top - fourth) < 0.35;
}

async function rerankPersonaWorldbookCandidates(query = '', candidates = [], options = {}) {
  const diagnostics = {
    applied: false,
    candidates: 0,
    reason: ''
  };
  if (!shouldRerankCandidates(candidates)) {
    diagnostics.reason = config.PERSONA_WORLDBOOK_RERANK_ENABLED === false ? 'disabled' : 'not_needed';
    return { results: candidates, diagnostics };
  }
  const maxCandidates = Math.max(
    2,
    Math.floor(Number(options.maxCandidates || config.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES || 24) || 24)
  );
  const rerankTimeoutMs = Math.max(
    0,
    Math.floor(Number(options.rerankTimeoutMs || config.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS || config.MEMORY_RERANK_TIMEOUT_MS || 2000) || 0)
  );
  const head = candidates.slice(0, maxCandidates);
  diagnostics.candidates = head.length;
  try {
    const rerank = typeof options.rerankCandidates === 'function'
      ? options.rerankCandidates
      : getMemoryReranker().rerankMemoryCandidates;
    if (typeof rerank !== 'function') {
      diagnostics.reason = 'rerank_unavailable';
      return { results: candidates, diagnostics };
    }
    const reranked = await rerank(query, head, {
      ...options,
      phase: 'persona_worldbook',
      maxCandidates,
      timeoutMs: rerankTimeoutMs,
      disableRerank: config.PERSONA_WORLDBOOK_RERANK_ENABLED === false
    });
    if (Array.isArray(reranked) && reranked.length > 0 && reranked !== head) {
      diagnostics.applied = reranked.some((item) => Number(item.rerankScore || 0) > 0);
      diagnostics.reason = diagnostics.applied ? 'rerank' : 'no_scores';
      return {
        results: uniqueBy(reranked.concat(candidates.slice(maxCandidates)), (item) => item.moduleId || item.id),
        diagnostics
      };
    }
    diagnostics.reason = 'no_scores';
    return { results: candidates, diagnostics };
  } catch (error) {
    diagnostics.reason = `failed:${error.message}`;
    return { results: candidates, diagnostics };
  }
}

async function withSoftTimeout(promiseFactory, timeoutMs, fallbackValue) {
  const budget = Math.max(0, Number(timeoutMs) || 0);
  if (!budget) return promiseFactory();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
    }, budget);
    Promise.resolve()
      .then(promiseFactory)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof fallbackValue === 'function' ? fallbackValue(error) : fallbackValue);
      });
  });
}

module.exports = {
  rerankPersonaWorldbookCandidates,
  shouldRerankCandidates,
  withSoftTimeout
};
