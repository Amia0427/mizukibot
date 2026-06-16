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

const rerankRuntimeState = {
  disabledUntil: 0,
  disabledReason: '',
  timeoutStreak: 0,
  failureStreak: 0,
  lastErrorAt: 0,
  lastErrorMessage: '',
  lastStatus: 0,
  lastTimeoutMs: 0,
  lastLatencyMs: 0,
  inFlight: 0,
  skippedInFlight: 0
};

class RerankTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`rerank request timed out after ${timeoutMs}ms`);
    this.name = 'RerankTimeoutError';
    this.code = 'ERR_MEMORY_RERANK_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function resolvePositiveMs(value, fallback = 0, min = 0) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : Number(fallback);
  if (!Number.isFinite(base)) return Math.max(0, min);
  return Math.max(min, Math.floor(base));
}

function resolveRerankEndpointCooldownMs() {
  return resolvePositiveMs(config.MEMORY_RERANK_ENDPOINT_COOLDOWN_MS, 30 * 60 * 1000, 0);
}

function resolveRerankTimeoutCooldownMs() {
  return resolvePositiveMs(config.MEMORY_RERANK_TIMEOUT_COOLDOWN_MS, 60 * 1000, 0);
}

function resolveRerankTimeoutFailureThreshold() {
  return Math.max(1, Math.floor(Number(config.MEMORY_RERANK_TIMEOUT_FAILURE_THRESHOLD || 2) || 2));
}

function resolveRerankMaxTimeoutMs(baseTimeoutMs) {
  const configured = Number(config.MEMORY_RERANK_MAX_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(baseTimeoutMs, Math.floor(configured));
  }
  return Math.max(baseTimeoutMs, Math.min(5000, baseTimeoutMs * 3));
}

function resolveRerankTimeoutMs(options = {}) {
  const raw = options.timeoutMs ?? options.rerankTimeoutMs ?? config.MEMORY_RERANK_TIMEOUT_MS ?? 8000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const baseTimeoutMs = Math.max(100, Math.floor(n));
  const hasExplicitTimeout = options.timeoutMs !== undefined || options.rerankTimeoutMs !== undefined;
  if (hasExplicitTimeout || options.disableAdaptiveTimeout === true) return baseTimeoutMs;
  const timeoutStreak = Math.max(0, Math.floor(Number(rerankRuntimeState.timeoutStreak || 0) || 0));
  if (timeoutStreak <= 0) return baseTimeoutMs;
  const stepMs = Math.max(100, Math.floor(baseTimeoutMs * 0.5));
  return Math.min(resolveRerankMaxTimeoutMs(baseTimeoutMs), baseTimeoutMs + (timeoutStreak * stepMs));
}

function formatMsForLog(value) {
  const ms = resolvePositiveMs(value, 0, 0);
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function setRerankDisabled(reason = '', cooldownMs = 0) {
  const ms = resolvePositiveMs(cooldownMs, 0, 0);
  const until = ms > 0 ? Date.now() + ms : 0;
  rerankRuntimeState.disabledUntil = until;
  rerankRuntimeState.disabledReason = normalizeText(reason);
  requestMemoryRerank.disabledUntil = until;
  return until;
}

function clearRerankFailureState(latencyMs = 0) {
  rerankRuntimeState.disabledUntil = 0;
  rerankRuntimeState.disabledReason = '';
  rerankRuntimeState.timeoutStreak = 0;
  rerankRuntimeState.failureStreak = 0;
  rerankRuntimeState.lastErrorAt = 0;
  rerankRuntimeState.lastErrorMessage = '';
  rerankRuntimeState.lastStatus = 0;
  rerankRuntimeState.lastTimeoutMs = 0;
  rerankRuntimeState.lastLatencyMs = Math.max(0, Math.floor(Number(latencyMs) || 0));
  requestMemoryRerank.disabledUntil = 0;
}

function shouldSkipBecauseRerankBusy(options = {}) {
  if (options.allowConcurrentRerank === true) return false;
  return Number(rerankRuntimeState.inFlight || 0) > 0;
}

function beginRerankRequest() {
  rerankRuntimeState.inFlight = Math.max(0, Number(rerankRuntimeState.inFlight || 0) || 0) + 1;
}

function endRerankRequest() {
  rerankRuntimeState.inFlight = Math.max(0, (Number(rerankRuntimeState.inFlight || 0) || 0) - 1);
}

function recordRerankBusySkip() {
  rerankRuntimeState.skippedInFlight = Math.max(0, Number(rerankRuntimeState.skippedInFlight || 0) || 0) + 1;
}

function recordRerankFailure(reason = 'request_failed', details = {}) {
  const normalizedReason = normalizeText(reason) || 'request_failed';
  const status = Number(details.status || 0) || 0;
  const timeoutMs = Number(details.timeoutMs || 0) || 0;
  const message = normalizeText(details.message || '');
  const now = Date.now();
  rerankRuntimeState.failureStreak += 1;
  rerankRuntimeState.timeoutStreak = normalizedReason === 'timeout'
    ? rerankRuntimeState.timeoutStreak + 1
    : 0;
  rerankRuntimeState.lastErrorAt = now;
  rerankRuntimeState.lastErrorMessage = message;
  rerankRuntimeState.lastStatus = status;
  rerankRuntimeState.lastTimeoutMs = timeoutMs;
  rerankRuntimeState.lastLatencyMs = Math.max(0, Math.floor(Number(details.latencyMs) || 0));

  const threshold = resolveRerankTimeoutFailureThreshold();
  let cooldownMs = 0;
  if (normalizedReason === 'endpoint_unavailable') {
    cooldownMs = resolveRerankEndpointCooldownMs();
  } else if (normalizedReason === 'timeout' && rerankRuntimeState.timeoutStreak >= threshold) {
    cooldownMs = resolveRerankTimeoutCooldownMs();
  } else if ((normalizedReason === 'rate_limit' || normalizedReason === 'transient_failure') && rerankRuntimeState.failureStreak >= threshold) {
    cooldownMs = resolveRerankTimeoutCooldownMs();
  }
  if (cooldownMs > 0) setRerankDisabled(normalizedReason, cooldownMs);
  return {
    cooldownMs,
    threshold,
    timeoutStreak: rerankRuntimeState.timeoutStreak,
    failureStreak: rerankRuntimeState.failureStreak
  };
}

function getMemoryRerankRuntimeState(now = Date.now()) {
  const disabledUntil = Math.max(
    Number(rerankRuntimeState.disabledUntil || 0) || 0,
    Number(requestMemoryRerank.disabledUntil || 0) || 0
  );
  return {
    disabled: disabledUntil > now,
    disabledUntil,
    disabledForMs: Math.max(0, disabledUntil - now),
    disabledReason: rerankRuntimeState.disabledReason || '',
    timeoutStreak: rerankRuntimeState.timeoutStreak,
    failureStreak: rerankRuntimeState.failureStreak,
    lastErrorAt: rerankRuntimeState.lastErrorAt,
    lastErrorMessage: rerankRuntimeState.lastErrorMessage,
    lastStatus: rerankRuntimeState.lastStatus,
    lastTimeoutMs: rerankRuntimeState.lastTimeoutMs,
    lastLatencyMs: rerankRuntimeState.lastLatencyMs,
    inFlight: rerankRuntimeState.inFlight,
    skippedInFlight: rerankRuntimeState.skippedInFlight
  };
}

function resetMemoryRerankRuntimeState() {
  clearRerankFailureState(0);
  rerankRuntimeState.inFlight = 0;
  rerankRuntimeState.skippedInFlight = 0;
}

function isAbortLikeError(error) {
  const code = String(error?.code || '').toUpperCase();
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'ERR_CANCELED'
    || code === 'ECONNABORTED'
    || code === 'ERR_MEMORY_RERANK_TIMEOUT'
    || name.includes('abort')
    || name.includes('timeout')
    || message.includes('canceled')
    || message.includes('aborted')
    || message.includes('timed out')
    || message.includes('timeout');
}

async function withHardTimeout(factory, timeoutMs, upstreamSignal = null) {
  const budget = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  if (!budget) return factory({ signal: upstreamSignal || null });
  if (upstreamSignal?.aborted) throw new RerankTimeoutError(budget);

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  let timeoutError = null;
  let removeUpstreamAbort = null;

  const abort = (reason) => {
    timeoutError = reason instanceof Error ? reason : new RerankTimeoutError(budget);
    if (controller && !controller.signal.aborted) {
      try {
        controller.abort(timeoutError);
      } catch (_) {
        controller.abort();
      }
    }
  };

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RerankTimeoutError(budget);
      abort(error);
      reject(error);
    }, budget);
    if (typeof timer.unref === 'function') timer.unref();
  });

  if (upstreamSignal && controller) {
    removeUpstreamAbort = () => {};
    const onAbort = () => abort(upstreamSignal.reason || new RerankTimeoutError(budget));
    if (upstreamSignal.aborted) {
      onAbort();
    } else if (typeof upstreamSignal.addEventListener === 'function') {
      upstreamSignal.addEventListener('abort', onAbort, { once: true });
      removeUpstreamAbort = () => upstreamSignal.removeEventListener('abort', onAbort);
    }
  }

  try {
    const signal = controller?.signal || upstreamSignal || null;
    return await Promise.race([
      Promise.resolve().then(() => factory({ signal, timeoutError: () => timeoutError })),
      timeoutPromise
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (removeUpstreamAbort) removeUpstreamAbort();
  }
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
  const disabledUntil = Math.max(
    Number(rerankRuntimeState.disabledUntil || 0) || 0,
    Number(requestMemoryRerank.disabledUntil || 0) || 0
  );
  if (disabledUntil && Date.now() < disabledUntil) return false;
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
  const slotHeld = options.__rerankSlotHeld === true;
  if (!slotHeld && shouldSkipBecauseRerankBusy(options)) {
    recordRerankBusySkip();
    return null;
  }
  const docs = (Array.isArray(documents) ? documents : [])
    .map((item) => clampText(item))
    .filter(Boolean);
  if (docs.length < 2) return null;

  const model = String(config.MEMORY_RERANK_MODEL || '').trim();
  const timeoutMs = resolveRerankTimeoutMs(options);
  const body = {
    model,
    query: normalizeText(query),
    documents: docs,
    top_n: Math.max(1, Math.min(docs.length, Number(options.topN || docs.length) || docs.length)),
    return_documents: false,
    __timeoutMs: timeoutMs || Math.max(1000, Number(config.MEMORY_RERANK_TIMEOUT_MS || 8000) || 8000),
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

  const startedAt = Date.now();
  if (!slotHeld) beginRerankRequest();
  try {
    const resp = await withHardTimeout(
      ({ signal }) => postWithRetry(
        getRerankApiBaseUrl(),
        signal ? { ...body, __abortSignal: signal } : body,
        0,
        getRerankApiKey()
      ),
      timeoutMs,
      options.abortSignal || null
    );
    clearRerankFailureState(Date.now() - startedAt);
    return extractRerankResults(resp);
  } catch (error) {
    const status = Number(error?.response?.status || 0) || 0;
    if (isAbortLikeError(error)) {
      const failure = recordRerankFailure('timeout', {
        status,
        timeoutMs,
        message: error.message,
        latencyMs: Date.now() - startedAt
      });
      if (failure.cooldownMs > 0) {
        console.warn(`[memoryReranker] rerank request timed out after ${timeoutMs || 'unknown'}ms (${failure.timeoutStreak}/${failure.threshold}), cooling down for ${formatMsForLog(failure.cooldownMs)}; fallback to base recall`);
      } else {
        console.warn(`[memoryReranker] rerank request timed out after ${timeoutMs || 'unknown'}ms, fallback to base recall`);
      }
      return null;
    }
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      const failure = recordRerankFailure('endpoint_unavailable', {
        status,
        message: error.message,
        latencyMs: Date.now() - startedAt
      });
      console.warn(`[memoryReranker] rerank endpoint unavailable (status ${status || 'unknown'}), fallback to base recall for ${formatMsForLog(failure.cooldownMs || resolveRerankEndpointCooldownMs())}`);
      return null;
    }
    if (status === 429 || status >= 500) {
      const failure = recordRerankFailure(status === 429 ? 'rate_limit' : 'transient_failure', {
        status,
        message: error.message,
        latencyMs: Date.now() - startedAt
      });
      if (failure.cooldownMs > 0) {
        console.warn(`[memoryReranker] rerank transient failure (status ${status || 'unknown'}), cooling down for ${formatMsForLog(failure.cooldownMs)}; fallback to base recall`);
        return null;
      }
    } else {
      recordRerankFailure('request_failed', {
        status,
        message: error.message,
        latencyMs: Date.now() - startedAt
      });
    }
    console.warn('[memoryReranker] rerank request failed, fallback to base recall:', error.message);
    return null;
  } finally {
    if (!slotHeld) endRerankRequest();
  }
}

async function withRerankSlot(options = {}, callback) {
  if (shouldSkipBecauseRerankBusy(options)) {
    recordRerankBusySkip();
    return { skipped: true, value: null };
  }
  beginRerankRequest();
  try {
    return { skipped: false, value: await callback() };
  } finally {
    endRerankRequest();
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
  const timeoutMs = resolveRerankTimeoutMs(options);

  let rows = null;
  try {
    const slotResult = await withRerankSlot(options, async () => {
      if (request === requestMemoryRerank) {
        return request(query, documents, {
          ...options,
          topN: head.length,
          timeoutMs,
          abortSignal: options.abortSignal || null,
          __rerankSlotHeld: true
        });
      }
      const startedAt = Date.now();
      const injectedRows = await withHardTimeout(
        ({ signal }) => request(query, documents, {
          ...options,
          topN: head.length,
          timeoutMs,
          abortSignal: signal || options.abortSignal || null
        }),
        timeoutMs,
        options.abortSignal || null
      );
      clearRerankFailureState(Date.now() - startedAt);
      return injectedRows;
    });
    if (slotResult.skipped) return list;
    rows = slotResult.value;
  } catch (error) {
    if (isAbortLikeError(error)) {
      recordRerankFailure('timeout', {
        timeoutMs,
        message: error.message
      });
      console.warn(`[memoryReranker] rerank candidate scoring timed out after ${timeoutMs || 'unknown'}ms, fallback to base recall`);
    } else {
      recordRerankFailure('request_failed', {
        message: error.message
      });
      console.warn('[memoryReranker] injected rerank request failed, fallback to base recall:', error.message);
    }
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
  resolveRerankTimeoutMs,
  getMemoryRerankRuntimeState,
  resetMemoryRerankRuntimeState,
  requestMemoryRerank,
  rerankMemoryCandidates
};
