const config = require('../config');
const { postWithRetry } = require('../api/httpClient');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampText(value, maxChars = config.MEMORY_RERANK_MAX_DOC_CHARS) {
  const text = normalizeText(value);
  const limit = Math.max(80, Math.floor(Number(maxChars) || 900));
  return text.length > limit ? text.slice(0, limit) : text;
}

function getRerankApiBaseUrl() {
  const raw = String(
    config.MEMORY_RERANK_API_BASE_URL
      || config.MEMORY_EMBEDDING_API_BASE_URL
      || ''
  ).replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/rerank$/i.test(raw)) return raw;
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/rerank');
  if (/\/embeddings$/i.test(raw)) return raw.replace(/\/embeddings$/i, '/rerank');
  if (/\/v\d+$/i.test(raw)) return `${raw}/rerank`;
  return `${raw}/rerank`;
}

function getRerankApiKey() {
  return String(
    config.MEMORY_RERANK_API_KEY
      || config.MEMORY_EMBEDDING_API_KEY
      || ''
  ).trim();
}

function shouldUseMemoryRerank(options = {}) {
  if (options.disableRerank) return false;
  if (requestMemoryRerank.disabledUntil && Date.now() < requestMemoryRerank.disabledUntil) return false;
  return Boolean(
    config.MEMORY_RERANK_ENABLED
      && String(config.MEMORY_RERANK_MODEL || '').trim()
      && getRerankApiBaseUrl()
      && getRerankApiKey()
  );
}

function parseResponseData(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function extractRerankResults(payload) {
  const body = parseResponseData(payload?.data ?? payload) || {};
  const rows = Array.isArray(body.results) ? body.results : [];
  return rows
    .map((row) => {
      const index = Number(row?.index);
      const rawScore = row?.relevance_score ?? row?.relevanceScore ?? row?.score;
      const score = Number(rawScore);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(score)) return null;
      return { index, score };
    })
    .filter(Boolean);
}

function normalizeScoreMap(scoreByIndex) {
  const values = Array.from(scoreByIndex.values()).filter((score) => Number.isFinite(score));
  if (values.length === 0) return new Map();
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min >= 0 && max <= 1) return new Map(scoreByIndex);
  if (max > min) {
    const out = new Map();
    for (const [index, score] of scoreByIndex.entries()) {
      out.set(index, (score - min) / (max - min));
    }
    return out;
  }
  const sigmoid = 1 / (1 + Math.exp(-values[0]));
  const out = new Map();
  for (const index of scoreByIndex.keys()) out.set(index, sigmoid);
  return out;
}

function normalizeBaseScores(candidates = []) {
  const scores = candidates.map((item) => Number(item?.score || item?.finalScore || 0)).filter((score) => Number.isFinite(score));
  if (scores.length === 0) return new Map();
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const out = new Map();
  candidates.forEach((item, index) => {
    const score = Number(item?.score || item?.finalScore || 0);
    out.set(index, max > min ? (score - min) / (max - min) : 0.5);
  });
  return out;
}

function buildMemoryRerankDocument(item = {}) {
  const tags = [
    item.source,
    item.type,
    item.memoryKind,
    item.tier,
    item.status
  ].map(normalizeText).filter(Boolean);
  const text = clampText(item.text || item.preview || item.canonicalText || '');
  return tags.length > 0 ? `[${tags.join('|')}] ${text}` : text;
}

async function requestMemoryRerank(query, documents = [], options = {}) {
  if (!shouldUseMemoryRerank(options)) return null;
  const docs = (Array.isArray(documents) ? documents : [])
    .map((item) => clampText(item))
    .filter(Boolean);
  if (docs.length < 2) return null;

  const model = String(config.MEMORY_RERANK_MODEL || '').trim();
  const body = {
    model,
    query: normalizeText(query),
    documents: docs,
    top_n: Math.max(1, Math.min(docs.length, Number(options.topN || docs.length) || docs.length)),
    return_documents: false,
    __timeoutMs: Math.max(1000, Number(config.MEMORY_RERANK_TIMEOUT_MS || 8000) || 8000),
    __trace: {
      source: 'memoryReranker',
      phase: options.phase || '',
      purpose: 'memory_rerank',
      userId: options.userId || ''
    }
  };

  if (config.MEMORY_RERANK_INSTRUCTION && /^Qwen\/Qwen3-Reranker-/i.test(model)) {
    body.instruction = String(config.MEMORY_RERANK_INSTRUCTION).trim();
  }

  try {
    const resp = await postWithRetry(getRerankApiBaseUrl(), body, 0, getRerankApiKey());
    requestMemoryRerank.disabledUntil = 0;
    return extractRerankResults(resp);
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      requestMemoryRerank.disabledUntil = Date.now() + (30 * 60 * 1000);
      console.warn('[memoryReranker] rerank endpoint unavailable, fallback to base recall for 30 minutes');
      return null;
    }
    console.warn('[memoryReranker] rerank request failed, fallback to base recall:', error.message);
    return null;
  }
}

async function rerankMemoryCandidates(query, candidates = [], options = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length < 2 || !shouldUseMemoryRerank(options)) return list;

  const maxCandidates = Math.max(2, Math.min(100, Math.floor(Number(options.maxCandidates || config.MEMORY_RERANK_MAX_CANDIDATES || 40) || 40)));
  const head = list.slice(0, maxCandidates);
  const tail = list.slice(maxCandidates);
  const documents = head.map(buildMemoryRerankDocument);
  const request = typeof options.requestRerank === 'function' ? options.requestRerank : requestMemoryRerank;

  let rows = null;
  try {
    rows = await request(query, documents, { ...options, topN: head.length });
  } catch (error) {
    console.warn('[memoryReranker] injected rerank request failed, fallback to base recall:', error.message);
    return list;
  }

  const scoreByIndex = new Map();
  for (const row of Array.isArray(rows) ? rows : extractRerankResults(rows)) {
    if (!row) continue;
    const index = Number(row.index);
    const score = Number(row.score);
    if (Number.isInteger(index) && index >= 0 && index < head.length && Number.isFinite(score)) {
      scoreByIndex.set(index, score);
    }
  }
  if (scoreByIndex.size === 0) return list;

  const rerankScores = normalizeScoreMap(scoreByIndex);
  const baseScores = normalizeBaseScores(head);
  const weight = clamp(options.scoreWeight ?? config.MEMORY_RERANK_SCORE_WEIGHT ?? 0.55, 0, 1);

  const rerankedHead = head.map((item, index) => {
    const preRerankScore = Number(item.score || item.finalScore || 0) || 0;
    const rerankScore = scoreByIndex.get(index);
    const rerankNormalizedScore = rerankScores.get(index);
    const baseScore = baseScores.get(index) ?? 0;
    const hasRerankScore = Number.isFinite(rerankNormalizedScore);
    const score = hasRerankScore
      ? (baseScore * (1 - weight)) + (rerankNormalizedScore * weight)
      : baseScore * (1 - weight) * 0.5;
    const reason = normalizeText(item.reason);
    return {
      ...item,
      preRerankScore,
      rerankScore: Number.isFinite(rerankScore) ? rerankScore : 0,
      rerankNormalizedScore: Number.isFinite(rerankNormalizedScore) ? rerankNormalizedScore : 0,
      score,
      finalScore: Object.prototype.hasOwnProperty.call(item, 'finalScore') ? score : item.finalScore,
      reason: reason ? `${reason}, rerank` : 'rerank'
    };
  }).sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    return Number(b.preRerankScore || 0) - Number(a.preRerankScore || 0);
  });

  if (tail.length === 0) return rerankedHead;
  const tailFloor = rerankedHead.length > 0
    ? Math.min(...rerankedHead.map((item) => Number(item.score || 0))) - 0.0001
    : 0;
  return rerankedHead.concat(tail.map((item) => ({
    ...item,
    preRerankScore: Number(item.score || item.finalScore || 0) || 0,
    score: tailFloor
  })));
}

module.exports = {
  getRerankApiBaseUrl,
  getRerankApiKey,
  shouldUseMemoryRerank,
  extractRerankResults,
  buildMemoryRerankDocument,
  requestMemoryRerank,
  rerankMemoryCandidates
};
