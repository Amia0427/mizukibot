const fs = require('fs');

const { listRecentModelCalls } = require('./modelCallTracker');
const { resolveObservabilityLogFile } = require('./memoryRecallObservability');

function normalizeInt(value, fallback = 20, min = 1, max = 200) {
  const parsed = Math.floor(Number(value || fallback) || fallback);
  return Math.max(min, Math.min(max, parsed));
}

function readRecentJsonLines(file, limit = 20) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizeInt(limit, 20, 1, 1000))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function hasDailyJournalBlock(prompt = {}) {
  const ids = Array.isArray(prompt.dynamicBlockIds) ? prompt.dynamicBlockIds : [];
  return ids.some((id) => String(id || '').includes('daily_journal'));
}

function summarizeMemoryTrace(trace = {}) {
  const value = trace && typeof trace === 'object' ? trace : {};
  const hits = Array.isArray(value.hits) ? value.hits : [];
  const lifecycleCounts = hits.reduce((acc, item) => {
    const status = String(item.lifecycleStatus || item.status || 'unknown').trim() || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    retrievalPath: value.retrieval_path || '',
    retrievedCount: Math.max(0, Number(value.retrieved_count || 0) || 0),
    droppedReasons: Array.isArray(value.dropped_reasons) ? value.dropped_reasons.slice(0, 12) : [],
    injectedBlockIds: Array.isArray(value.injected_block_ids) ? value.injected_block_ids.slice(0, 12) : [],
    lifecycleCounts,
    conflictHiddenCount: hits.filter((item) => String(item.selectionReason || item.traceReason || item.recallHiddenReason || '').includes('memory_conflict_resolved')).length,
    hasMemoryRecallPolicy: Array.isArray(value.injected_block_ids) && value.injected_block_ids.includes('memory_recall_policy'),
    hits: hits.length > 0
      ? hits.slice(0, 12).map((item) => ({
          id: item.id || '',
          source: item.source || '',
          sourceKind: item.sourceKind || '',
          category: item.category || '',
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
          intent: item.intent || '',
          status: item.status || '',
          lifecycleStatus: item.lifecycleStatus || '',
          scopeType: item.scopeType || '',
          score: Number(item.score || 0) || 0,
          matchMode: item.matchMode || '',
          selectionReason: item.selectionReason || item.traceReason || '',
          injected: item.injected === true,
          preview: item.preview || ''
        }))
      : []
  };
}

function summarizeObservation(row = {}) {
  const prompt = row.prompt && typeof row.prompt === 'object' ? row.prompt : {};
  const continuity = prompt.shortTermContinuity && typeof prompt.shortTermContinuity === 'object'
    ? prompt.shortTermContinuity
    : {};
  const memoryTrace = row.memoryTrace && typeof row.memoryTrace === 'object'
    ? row.memoryTrace
    : (row.localMemory?.trace && typeof row.localMemory.trace === 'object' ? row.localMemory.trace : null);
  return {
    ts: row.recordedAt || '',
    userId: row.userId || '',
    routePolicyKey: row.routePolicyKey || '',
    topRouteType: row.topRouteType || '',
    shortTermContinuity: continuity,
    hasShortTermContinuity: prompt.hasShortTermContinuity === true,
    hasRetrievedMemoryLite: prompt.hasRetrievedMemoryLite === true,
    hasDailyJournal: hasDailyJournalBlock(prompt),
    hasMemosRecall: prompt.hasMemosRecall === true,
    localMemoryEvidenceCount: Math.max(0, Number(row.localMemory?.evidenceCount || 0) || 0),
    memoryTrace: summarizeMemoryTrace(memoryTrace || {}),
    memosUsed: row.memos?.used === true,
    drop: row.drop || {}
  };
}

function summarizeModelCall(call = {}) {
  return {
    ts: call.completed_at || call.started_at || call.ts || '',
    source: call.source || '',
    status: call.status || '',
    routePolicyKey: call.route_policy_key || '',
    topRouteType: call.top_route_type || '',
    promptIntegrity: call.prompt_integrity || {}
  };
}

function buildMainReplyContextPreview(options = {}) {
  const limit = normalizeInt(options.limit, 12, 1, 50);
  const observabilityFile = options.observabilityFile || resolveObservabilityLogFile();
  const observations = readRecentJsonLines(observabilityFile, Math.max(20, limit * 5))
    .filter((row) => String(row.stage || '') === 'prepare_main_prompt_blocks' || row.prompt)
    .slice(-limit)
    .map(summarizeObservation);
  const calls = (typeof options.listModelCalls === 'function'
    ? options.listModelCalls(limit)
    : listRecentModelCalls(limit)
  ).map(summarizeModelCall);
  return {
    schemaVersion: 'main_reply_context_preview_v1',
    updatedAt: new Date().toISOString(),
    observabilityFile,
    modelCalls: calls,
    observations
  };
}

module.exports = {
  buildMainReplyContextPreview,
  readRecentJsonLines,
  summarizeMemoryTrace,
  summarizeObservation
};
