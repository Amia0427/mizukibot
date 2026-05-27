const config = require('../../config');
const {
  getOpenVikingRecallPromptText,
  recallOpenVikingForPrompt
} = require('./recall');
const {
  clampText,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./text');
const { createOpenVikingClient } = require('./client');
const { buildIdentity } = require('./identity');

function formatCliSearchResult(item = {}, index = 0) {
  const row = normalizeObject(item, {});
  const ref = normalizeText(row.ref || (row.uri ? `ov_ref:${row.uri}` : row.id));
  return {
    rank: index + 1,
    source: 'openviking',
    id: normalizeText(row.id || row.uri || ref),
    ref,
    uri: normalizeText(row.uri),
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
    text: clampText(row.text || row.abstract || row.uri, 420),
    preview: clampText(row.text || row.abstract || row.uri, 220),
    title: normalizeText(row.title),
    why: normalizeText(row.why || row.category || row.title)
  };
}

async function searchOpenVikingForMemoryCli(parsed = {}, context = {}, options = {}) {
  const recall = await recallOpenVikingForPrompt(parsed.query, {
    ...context,
    ...options,
    config: options.config || config,
    topK: parsed.limit || config.OPENVIKING_RECALL_TOP_K
  });
  const results = normalizeArray(recall.items).map(formatCliSearchResult);
  return {
    ok: recall.used === true,
    command: 'search',
    count: results.length,
    results,
    digest: getOpenVikingRecallPromptText(recall),
    sourceCoverage: { openviking: results.length },
    queryFacet: 'openviking',
    candidateCounts: {
      openviking: Number(recall.diagnostics?.rawCandidateCount || results.length) || results.length
    },
    diagnostics: recall.diagnostics || {},
    rejectedReason: recall.rejectedReason || ''
  };
}

function parseOpenVikingRef(ref = '') {
  const text = normalizeText(ref);
  if (!text.startsWith('ov_ref:')) return '';
  return text.slice('ov_ref:'.length);
}

async function openOpenVikingMemory(parsed = {}, context = {}, options = {}) {
  const uri = parseOpenVikingRef(parsed.ref) || normalizeText(parsed.id);
  if (!uri) return null;
  const cfg = options.config || config;
  const identity = buildIdentity(cfg, {
    userId: context.userId || options.userId,
    senderId: context.senderId || context.userId || options.senderId || options.userId,
    groupId: context.groupId || options.groupId,
    platform: context.platform || context.channel || options.platform || 'qq'
  });
  const client = options.client || createOpenVikingClient(cfg, {
    timeoutMs: cfg.OPENVIKING_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const auth = {
    apiKey: options.apiKey || cfg.OPENVIKING_API_KEY || cfg.OPENVIKING_ADMIN_API_KEY,
    userId: normalizeText(options.openVikingUserHeader || identity.openVikingUserId)
  };
  try {
    const text = await client.readContent(uri, auth);
    return {
      source: 'openviking',
      id: uri,
      data: {
        uri,
        text: clampText(text || uri, Math.max(1000, Number(cfg.MEMORY_CLI_MAX_OPEN_CHARS || 12000) || 12000))
      }
    };
  } catch (error) {
    return {
      source: 'openviking',
      id: uri,
      data: {
        uri,
        error: error?.message || String(error || '')
      }
    };
  }
}

module.exports = {
  formatCliSearchResult,
  openOpenVikingMemory,
  parseOpenVikingRef,
  searchOpenVikingForMemoryCli
};
