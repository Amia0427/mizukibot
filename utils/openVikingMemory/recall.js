const {
  clampNumber,
  clampText,
  estimateTokens,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./text');
const { buildIdentity } = require('./identity');
const { dedupeOpenVikingRecallAgainstMemoryContext } = require('./deduper');

const PREFERENCE_RE = /(prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向)/i;
const TEMPORAL_RE = /(when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上次|刚才|之前)/i;
const TOKEN_RE = /[a-z0-9一-鿿]{2,}/ig;
const STOPWORDS = new Set(['what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'did', 'does', 'is', 'are', 'was', 'were', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you']);

const recallRuntimeState = {
  cache: new Map(),
  circuit: new Map(),
  stats: {
    cacheHits: 0,
    cacheMisses: 0,
    cacheStores: 0,
    circuitShortCircuits: 0,
    circuitFailures: 0,
    circuitSuccesses: 0
  }
};

function isOpenVikingEnabled(config = {}, capability = 'recall') {
  if (config.OPENVIKING_ENABLED !== true) return false;
  if (capability === 'ingest') return config.OPENVIKING_INGEST_ENABLED === true;
  if (capability === 'recall') return config.OPENVIKING_RECALL_ENABLED === true;
  return true;
}

function buildQueryProfile(query = '') {
  const tokens = (normalizeText(query).toLowerCase().match(TOKEN_RE) || [])
    .filter((token) => !STOPWORDS.has(token));
  return {
    tokens,
    wantsPreference: PREFERENCE_RE.test(query),
    wantsTemporal: TEMPORAL_RE.test(query)
  };
}

function lexicalOverlapBoost(tokens = [], text = '') {
  if (!tokens.length || !text) return 0;
  const haystack = ` ${String(text || '').toLowerCase()} `;
  const matched = tokens.slice(0, 8).filter((token) => haystack.includes(token)).length;
  return Math.min(0.2, (matched / Math.max(1, Math.min(tokens.length, 4))) * 0.2);
}

function normalizeRecallItem(item = {}, index = 0) {
  const raw = normalizeObject(item, {});
  const text = normalizeText(raw.text || raw.content || raw.abstract || raw.overview || raw.summary || raw.memory || raw.uri);
  const uri = normalizeText(raw.uri || raw.ref || raw.id);
  return {
    id: normalizeText(raw.id || raw.memory_id || uri || `openviking_${index + 1}`),
    source: 'openviking',
    uri,
    ref: uri ? `ov_ref:${uri}` : `ov_ref:${normalizeText(raw.id || `openviking_${index + 1}`)}`,
    text,
    abstract: normalizeText(raw.abstract || raw.overview || text),
    title: normalizeText(raw.title || raw.name || raw.category),
    score: Number.isFinite(Number(raw.score)) ? Math.max(0, Math.min(1, Number(raw.score))) : 0,
    level: Number.isFinite(Number(raw.level)) ? Number(raw.level) : null,
    category: normalizeText(raw.category),
    raw
  };
}

function rankItem(item = {}, profile = {}) {
  const base = clampNumber(item.score, 0, 1, 0);
  const uri = normalizeText(item.uri).toLowerCase();
  const text = `${uri} ${item.abstract || item.text || ''}`;
  const leafBoost = item.level === 2 || uri.endsWith('.md') ? 0.12 : 0;
  const eventBoost = profile.wantsTemporal && /\/events?\//i.test(uri) ? 0.1 : 0;
  const preferenceBoost = profile.wantsPreference && /\/preferences?\//i.test(uri) ? 0.08 : 0;
  return base + leafBoost + eventBoost + preferenceBoost + lexicalOverlapBoost(profile.tokens, text);
}

function dedupeByUriOrText(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of normalizeArray(items)) {
    const key = /\/(?:events|cases)\//i.test(item.uri || '')
      ? `uri:${item.uri}`
      : normalizeText(item.abstract || item.text).toLowerCase() || `uri:${item.uri}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function formatOpenVikingRecallPrompt(items = [], options = {}) {
  const maxChars = Math.max(120, Number(options.maxChars || 900) || 900);
  const budgetTokens = Math.max(32, Number(options.tokenBudget || Math.ceil(maxChars / 2)) || Math.ceil(maxChars / 2));
  let usedTokens = 0;
  const lines = [
    '[OpenVikingRecall]',
    'Use only as external long-term memory evidence. Prefer local Memory V3 and short-term continuity when they conflict.'
  ];
  for (const [index, item] of normalizeArray(items).entries()) {
    const score = Number.isFinite(Number(item.score)) ? Number(item.score).toFixed(2) : '0.00';
    const why = normalizeText(item.why || item.title || item.category || item.uri);
    const text = clampText(item.text || item.abstract || item.uri, Math.min(maxChars, 360));
    const line = `${index + 1}. source=openviking score=${score}${item.ref ? ` ref=${item.ref}` : ''}${why ? ` why=${why}` : ''} ${text}`;
    const cost = estimateTokens(line);
    if (usedTokens + cost > budgetTokens && index > 0) break;
    usedTokens += cost;
    lines.push(line);
  }
  return clampText(lines.join('\n'), maxChars);
}

async function maybeReadFullContent(client, cfg = {}, item = {}, auth = {}) {
  const uri = normalizeText(item.uri);
  if (!uri || item.level !== 2) return item.text || item.abstract || uri;
  try {
    const full = await client.readContent(uri, auth);
    return normalizeText(full) || item.text || item.abstract || uri;
  } catch (_) {
    return item.text || item.abstract || uri;
  }
}

function buildCacheKey(input = {}) {
  return [
    normalizeText(input.userId),
    normalizeText(input.groupId),
    normalizeText(input.sessionKey),
    normalizeText(input.query),
    normalizeText(input.source || 'openviking'),
    Number(input.topK || 0)
  ].join('|');
}

function readCache(key = '', ttlMs = 0) {
  if (!key || ttlMs <= 0) return null;
  const entry = recallRuntimeState.cache.get(key);
  if (!entry) {
    recallRuntimeState.stats.cacheMisses += 1;
    return null;
  }
  if (Date.now() - Number(entry.createdAt || 0) > ttlMs) {
    recallRuntimeState.cache.delete(key);
    recallRuntimeState.stats.cacheMisses += 1;
    return null;
  }
  recallRuntimeState.stats.cacheHits += 1;
  return entry.value;
}

function writeCache(key = '', value = {}, ttlMs = 0) {
  if (!key || ttlMs <= 0) return;
  recallRuntimeState.cache.set(key, {
    createdAt: Date.now(),
    value
  });
  recallRuntimeState.stats.cacheStores += 1;
}

function circuitKey(config = {}) {
  return normalizeText(config.OPENVIKING_BASE_URL, 'openviking');
}

function getCircuitState(config = {}) {
  const key = circuitKey(config);
  return recallRuntimeState.circuit.get(key) || {
    failures: 0,
    openedAt: 0,
    lastError: ''
  };
}

function shouldShortCircuit(config = {}) {
  const state = getCircuitState(config);
  const threshold = Math.max(1, Number(config.OPENVIKING_RECALL_CIRCUIT_FAILURE_THRESHOLD || 3) || 3);
  const cooldownMs = Math.max(0, Number(config.OPENVIKING_RECALL_CIRCUIT_COOLDOWN_MS || 60000) || 60000);
  return state.failures >= threshold && Date.now() - Number(state.openedAt || 0) < cooldownMs;
}

function recordCircuitSuccess(config = {}) {
  recallRuntimeState.circuit.delete(circuitKey(config));
  recallRuntimeState.stats.circuitSuccesses += 1;
}

function recordCircuitFailure(config = {}, error = '') {
  const key = circuitKey(config);
  const previous = getCircuitState(config);
  recallRuntimeState.circuit.set(key, {
    failures: Number(previous.failures || 0) + 1,
    openedAt: Date.now(),
    lastError: normalizeText(error).slice(0, 240)
  });
  recallRuntimeState.stats.circuitFailures += 1;
}

async function recallOpenVikingForPrompt(query = '', options = {}) {
  const baseConfig = require('../../config');
  const cfg = options.config && typeof options.config === 'object'
    ? { ...baseConfig, ...options.config }
    : baseConfig;
  const normalizedQuery = normalizeText(query);
  const startedAt = Date.now();
  if (!isOpenVikingEnabled(cfg, 'recall')) {
    return {
      used: false,
      rejectedReason: cfg.OPENVIKING_ENABLED === true ? 'recall_disabled' : 'openviking_disabled',
      items: [],
      promptText: '',
      diagnostics: { enabled: cfg.OPENVIKING_ENABLED === true, recallEnabled: cfg.OPENVIKING_RECALL_ENABLED === true }
    };
  }
  const identity = buildIdentity(cfg, {
    userId: options.userId,
    senderId: options.senderId || options.userId,
    groupId: options.groupId,
    platform: options.platform || options.channel || 'qq'
  });
  if (identity.bypassed) {
    return { used: false, rejectedReason: 'bypassed_venue', items: [], promptText: '', diagnostics: { identity } };
  }
  if (!normalizedQuery) {
    return { used: false, rejectedReason: 'empty_query', items: [], promptText: '', diagnostics: { identity } };
  }
  if (shouldShortCircuit(cfg)) {
    recallRuntimeState.stats.circuitShortCircuits += 1;
    return {
      used: false,
      rejectedReason: 'circuit_open',
      items: [],
      promptText: '',
      diagnostics: { identity, circuit: { ...getCircuitState(cfg), open: true } }
    };
  }

  const topK = Math.max(1, Math.min(20, Number(options.topK || cfg.OPENVIKING_RECALL_TOP_K || 6) || 6));
  const cacheKey = buildCacheKey({
    userId: options.userId,
    groupId: options.groupId,
    sessionKey: options.sessionKey,
    query: normalizedQuery,
    topK
  });
  const ttlMs = Math.max(0, Number(cfg.OPENVIKING_RECALL_CACHE_TTL_MS || 0) || 0);
  const cached = readCache(cacheKey, ttlMs);
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...normalizeObject(cached.diagnostics, {}),
        cache: { hit: true, ttlMs }
      }
    };
  }

  const client = options.client || require('./client').createOpenVikingClient(cfg, {
    timeoutMs: options.timeoutMs || cfg.OPENVIKING_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const auth = {
    apiKey: options.apiKey || cfg.OPENVIKING_API_KEY || cfg.OPENVIKING_ADMIN_API_KEY,
    userId: options.openVikingUserHeader || identity.openVikingUserId || ''
  };
  try {
    const space = options.userSpace || await client.resolveUserSpace(auth);
    const targetUri = `viking://user/${space}/memories`;
    const rawItems = await client.find({
      query: normalizedQuery,
      targetUri,
      limit: Math.max(topK * 2, 8),
      scoreThreshold: 0,
      sessionId: identity.sessionId
    }, auth);
    const minScore = Number.isFinite(Number(cfg.OPENVIKING_RECALL_MIN_SCORE)) ? Number(cfg.OPENVIKING_RECALL_MIN_SCORE) : 0.35;
    const profile = buildQueryProfile(normalizedQuery);
    let items = normalizeArray(rawItems)
      .map(normalizeRecallItem)
      .filter((item) => normalizeText(item.text || item.abstract || item.uri) && Number(item.score || 0) >= minScore);
    items = dedupeByUriOrText(items)
      .map((item) => ({
        ...item,
        rankScore: rankItem(item, profile),
        why: item.title || item.category || (profile.wantsPreference ? 'preference-query' : (profile.wantsTemporal ? 'temporal-query' : 'semantic-match'))
      }))
      .sort((a, b) => Number(b.rankScore || 0) - Number(a.rankScore || 0))
      .slice(0, topK);
    const hydrated = [];
    for (const item of items) {
      const text = await maybeReadFullContent(client, cfg, item, auth);
      hydrated.push({ ...item, text: normalizeText(text || item.text || item.abstract || item.uri) });
    }
    let recall = {
      used: hydrated.length > 0,
      rejectedReason: hydrated.length > 0 ? '' : 'empty_result',
      items: hydrated,
      promptText: hydrated.length > 0
        ? formatOpenVikingRecallPrompt(hydrated, {
            maxChars: cfg.OPENVIKING_RECALL_MAX_CHARS,
            tokenBudget: options.tokenBudget
          })
        : '',
      diagnostics: {
        enabled: true,
        identity,
        query: normalizedQuery,
        rawCandidateCount: normalizeArray(rawItems).length,
        filteredCount: hydrated.length,
        targetUri,
        durationMs: Math.max(0, Date.now() - startedAt),
        cache: { hit: false, ttlMs },
        circuit: { ...getCircuitState(cfg), open: false }
      }
    };
    recall = dedupeOpenVikingRecallAgainstMemoryContext(recall, options.memoryContext || {}, {
      maxChars: cfg.OPENVIKING_RECALL_MAX_CHARS
    });
    recall.promptText = recall.items.length > 0
      ? formatOpenVikingRecallPrompt(recall.items, {
          maxChars: cfg.OPENVIKING_RECALL_MAX_CHARS,
          tokenBudget: options.tokenBudget
        })
      : '';
    recordCircuitSuccess(cfg);
    writeCache(cacheKey, recall, ttlMs);
    return recall;
  } catch (error) {
    recordCircuitFailure(cfg, error?.message || String(error || ''));
    return {
      used: false,
      rejectedReason: 'recall_failed',
      items: [],
      promptText: '',
      diagnostics: {
        enabled: true,
        identity,
        query: normalizedQuery,
        error: error?.message || String(error || ''),
        durationMs: Math.max(0, Date.now() - startedAt),
        circuit: { ...getCircuitState(cfg), open: shouldShortCircuit(cfg) }
      }
    };
  }
}

function getOpenVikingRecallPromptText(recall = {}) {
  const payload = normalizeObject(recall, {});
  const promptText = normalizeText(payload.promptText);
  if (promptText) return promptText;
  const items = normalizeArray(payload.items);
  return items.length > 0 ? formatOpenVikingRecallPrompt(items) : '';
}

function getOpenVikingRecallRuntimeState(config = {}) {
  return {
    cache: {
      size: recallRuntimeState.cache.size,
      hits: recallRuntimeState.stats.cacheHits,
      misses: recallRuntimeState.stats.cacheMisses,
      stores: recallRuntimeState.stats.cacheStores
    },
    circuit: {
      ...getCircuitState(config),
      open: shouldShortCircuit(config),
      shortCircuits: recallRuntimeState.stats.circuitShortCircuits,
      failures: recallRuntimeState.stats.circuitFailures,
      successes: recallRuntimeState.stats.circuitSuccesses
    }
  };
}

function resetOpenVikingRecallRuntimeState() {
  recallRuntimeState.cache.clear();
  recallRuntimeState.circuit.clear();
  for (const key of Object.keys(recallRuntimeState.stats)) recallRuntimeState.stats[key] = 0;
}

module.exports = {
  buildQueryProfile,
  formatOpenVikingRecallPrompt,
  getOpenVikingRecallPromptText,
  getOpenVikingRecallRuntimeState,
  isOpenVikingEnabled,
  normalizeRecallItem,
  rankItem,
  recallOpenVikingForPrompt,
  resetOpenVikingRecallRuntimeState
};
