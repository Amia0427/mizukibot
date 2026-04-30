const config = require('../config');
const { postWithRetry } = require('../api/httpClient');

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function trimTrailingSlash(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getRerankApiBaseUrl() {
  const raw = trimTrailingSlash(config.MEMORY_RERANK_API_BASE_URL || config.MEMORY_API_BASE_URL || config.API_BASE_URL || '');
  if (!raw) return '';
  if (/\/rerank$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/rerank`;
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/rerank');
  return `${raw}/rerank`;
}

function getRerankApiKey() {
  return String(config.MEMORY_RERANK_API_KEY || config.MEMORY_API_KEY || config.API_KEY || '').trim();
}

function getRerankModel() {
  return String(config.MEMORY_RERANK_MODEL || '').trim();
}

function isRerankConfigured() {
  return Boolean(
    config.MEMORY_RERANK_ENABLED
    && getRerankModel()
    && getRerankApiBaseUrl()
    && getRerankApiKey()
  );
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n >= 0 && n <= 1) return n;
  return Math.max(0, Math.min(1, n));
}

function parseRerankResponse(response) {
  const payload = response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response;
  const rows = Array.isArray(payload?.results)
    ? payload.results
    : (Array.isArray(payload?.data) ? payload.data : []);

  return rows
    .map((row, fallbackIndex) => ({
      index: Number.isInteger(row?.index) ? row.index : (Number.isInteger(row?.document_index) ? row.document_index : fallbackIndex),
      score: normalizeScore(row?.relevance_score ?? row?.score ?? row?.rerank_score)
    }))
    .filter((row) => Number.isInteger(row.index) && row.index >= 0);
}

function mergeRerankScores(candidates = [], rerankRows = [], options = {}) {
  const weight = Math.max(0, Math.min(1, Number(options.weight ?? config.MEMORY_RERANK_WEIGHT ?? 0.35) || 0));
  if (!Array.isArray(candidates) || candidates.length === 0 || !Array.isArray(rerankRows) || rerankRows.length === 0 || weight <= 0) {
    return Array.isArray(candidates) ? candidates : [];
  }

  const byIndex = new Map();
  for (const row of rerankRows) {
    byIndex.set(Number(row.index), normalizeScore(row.score));
  }

  return candidates
    .map((candidate, index) => {
      if (!byIndex.has(index)) return candidate;
      const rerankScore = byIndex.get(index);
      const baseScore = Number(candidate.score || 0);
      return {
        ...candidate,
        rerankScore,
        preRerankScore: candidate.preRerankScore ?? baseScore,
        score: (baseScore * (1 - weight)) + (rerankScore * weight)
      };
    })
    .sort((a, b) => {
      if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
      return Number(b.rerankScore || 0) - Number(a.rerankScore || 0);
    });
}

async function rerankMemoryCandidates(query = '', candidates = [], options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return list;
  if (typeof options.rerankCandidates === 'function') {
    return options.rerankCandidates(query, list, options);
  }
  if (!isRerankConfigured()) return list;
  if (rerankMemoryCandidates.disabledUntil && Date.now() < rerankMemoryCandidates.disabledUntil) return list;

  const limit = Math.max(1, Number(options.rerankCandidateLimit || config.MEMORY_RERANK_CANDIDATE_LIMIT || 12) || 12);
  const head = list.slice(0, limit);
  const tail = list.slice(limit);
  const documents = head.map((candidate) => sanitizeText(candidate.text || candidate.canonicalText || ''));
  if (documents.length === 0) return list;

  try {
    const response = await postWithRetry(
      getRerankApiBaseUrl(),
      {
        model: getRerankModel(),
        query: sanitizeText(query),
        documents,
        top_n: documents.length,
        __timeoutMs: Math.max(1000, Number(options.timeoutMs || config.MEMORY_RERANK_TIMEOUT_MS) || 12000),
        __trace: {
          source: 'memoryRerankClient',
          purpose: 'memory_rerank'
        }
      },
      0,
      getRerankApiKey()
    );
    rerankMemoryCandidates.disabledUntil = 0;
    const rows = parseRerankResponse(response);
    return mergeRerankScores(head, rows, options).concat(tail);
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
    if (status === 400 || status === 404) {
      rerankMemoryCandidates.disabledUntil = Date.now() + (30 * 60 * 1000);
      console.warn('[memoryRerankClient] rerank endpoint unavailable, falling back for 30 minutes');
    } else {
      console.error('[memoryRerankClient] rerank request failed:', error.message);
    }
    return list;
  }
}

module.exports = {
  getRerankApiBaseUrl,
  getRerankApiKey,
  getRerankModel,
  isRerankConfigured,
  parseRerankResponse,
  mergeRerankScores,
  rerankMemoryCandidates
};
