const path = require('path');
const crypto = require('crypto');
const {
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync
} = require('./logRotation');
const {
  currentTraceFields,
  normalizeRequestTrace
} = require('./requestTrace');

const DEFAULT_PREVIEW_CHARS = 160;

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function stableHash(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  return crypto
    .createHash('sha1')
    .update(text)
    .digest('hex')
    .slice(0, 16);
}

function truncatePreview(value = '', maxChars = DEFAULT_PREVIEW_CHARS) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!text || !limit) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12)).trim()} [truncated]`;
}

function resolveObservabilityLogFile() {
  try {
    const config = require('../config');
    return path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'memory-recall-observability.ndjson');
  } catch (_) {
    return path.join(process.cwd(), 'data', 'memory-recall-observability.ndjson');
  }
}

function pickRouteMeta(input = {}) {
  const routeMeta = normalizeObject(input.routeMeta, normalizeObject(input.route?.meta, {}));
  const trace = normalizeRequestTrace(input.requestTrace)
    || normalizeRequestTrace(routeMeta.requestTrace)
    || normalizeRequestTrace(input.trace);
  return { routeMeta, trace };
}

function baseLogFields(input = {}) {
  const { routeMeta, trace } = pickRouteMeta(input);
  return {
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    ...currentTraceFields(trace, {}),
    stage: normalizeText(input.stage, 'unknown'),
    userId: normalizeText(input.userId || routeMeta.userId || trace?.userId),
    groupId: normalizeText(routeMeta.groupId || routeMeta.group_id || trace?.groupId),
    chatType: normalizeText(routeMeta.chatType || routeMeta.chat_type || trace?.chatType),
    routePolicyKey: normalizeText(input.routePolicyKey || routeMeta.routePolicyKey || routeMeta.policyKey),
    routeDebugKey: normalizeText(routeMeta.routeDebugKey || routeMeta.debugKey),
    topRouteType: normalizeText(input.topRouteType || routeMeta.topRouteType || input.route?.topRouteType)
  };
}

function summarizeRecallItems(items = [], options = {}) {
  const previewChars = Math.max(20, Math.floor(Number(options.previewChars || DEFAULT_PREVIEW_CHARS) || DEFAULT_PREVIEW_CHARS));
  return normalizeArray(items)
    .map((item, index) => {
      const normalized = normalizeObject(item, {});
      const text = normalizeText(normalized.text || normalized.content || normalized.memory || normalized.summary);
      return {
        index,
        id: normalizeText(normalized.id || normalized.memory_id || normalized.ref),
        title: truncatePreview(normalized.title || normalized.name || normalized.file_name, 80),
        source: normalizeText(normalized.source || normalized.type),
        score: Number.isFinite(Number(normalized.score)) ? Number(normalized.score) : null,
        createdAt: normalizeText(normalized.createdAt || normalized.created_at || normalized.time || normalized.timestamp),
        textPreview: truncatePreview(text, previewChars),
        textHash: stableHash(text)
      };
    })
    .filter((item) => item.id || item.textHash || item.textPreview);
}

function summarizeDedupedRemovedItems(dedupe = {}) {
  return normalizeArray(dedupe.removedItems)
    .map((item) => {
      const normalized = normalizeObject(item, {});
      const text = normalizeText(normalized.text);
      return {
        id: normalizeText(normalized.id),
        reason: normalizeText(normalized.reason),
        textPreview: truncatePreview(text, DEFAULT_PREVIEW_CHARS),
        textHash: stableHash(text)
      };
    })
    .filter((item) => item.id || item.reason || item.textHash);
}

function countLocalMemoryEvidence(memoryContext = {}) {
  const context = normalizeObject(memoryContext, {});
  const values = [
    context.promptRetrievedMemoryText,
    context.retrievedMemoryForPrompt,
    context.memoryForPrompt,
    context.promptTaskMemoryText,
    context.taskMemoryText,
    context.promptGroupMemoryText,
    context.groupMemoryText,
    context.promptStyleSignalText,
    context.styleSignalText,
    context.promptDailyJournalText,
    context.dailyJournalText,
    context.promptLongTermProfileText,
    context.longTermProfileText,
    context.profileText
  ];
  return values.reduce((count, value) => count + (normalizeText(value) ? 1 : 0), 0);
}

function summarizeMemosRecall(recall = {}, options = {}) {
  const normalized = normalizeObject(recall, {});
  const diagnostics = normalizeObject(normalized.diagnostics, {});
  const dedupe = normalizeObject(diagnostics.dedupe, {});
  const items = normalizeArray(normalized.items);
  return {
    enabled: diagnostics.enabled === true,
    used: normalized.used === true,
    rejectedReason: normalizeText(normalized.rejectedReason),
    recallSource: normalizeText(diagnostics.recallSource),
    sourceToolName: normalizeText(diagnostics.sourceToolName),
    kbToolName: normalizeText(diagnostics.kbToolName),
    searchToolName: normalizeText(diagnostics.searchToolName),
    serverName: normalizeText(diagnostics.serverName),
    durationMs: Math.max(0, Number(diagnostics.durationMs || 0) || 0),
    timeoutMs: Math.max(0, Number(diagnostics.timeoutMs || 0) || 0),
    knowledgebaseIdsCount: Math.max(0, Number(diagnostics.knowledgebaseIdsCount || 0) || 0),
    candidateCount: items.length,
    promptChars: normalizeText(normalized.promptText).length,
    queryHash: stableHash(normalized.query),
    queryPreview: truncatePreview(normalized.query, 120),
    diagnosticsError: normalizeText(diagnostics.error),
    dedupe: {
      enabled: dedupe.enabled === true,
      localEvidenceCount: Math.max(0, Number(dedupe.localEvidenceCount || 0) || 0),
      kept: Math.max(0, Number(dedupe.kept || 0) || 0),
      removed: Math.max(0, Number(dedupe.removed || 0) || 0),
      removedItems: summarizeDedupedRemovedItems(dedupe)
    },
    items: summarizeRecallItems(items, options)
  };
}

function appendObservation(payload = {}) {
  try {
    appendFileWithRotationBatched(
      resolveObservabilityLogFile(),
      `${JSON.stringify(payload)}\n`,
      { encoding: 'utf8' }
    );
  } catch (_) {}
}

function recordMemosPlannerRecallObservation(input = {}) {
  const rawRecall = normalizeObject(input.rawRecall, {});
  const dedupedRecall = normalizeObject(input.dedupedRecall, {});
  const rawDedupe = normalizeObject(normalizeObject(rawRecall.diagnostics, {}).dedupe, {});
  const dedupedDedupe = normalizeObject(normalizeObject(dedupedRecall.diagnostics, {}).dedupe, {});
  appendObservation({
    ...baseLogFields(input),
    stage: normalizeText(input.stage, 'planner_memos_recall'),
    queryHash: stableHash(input.query || rawRecall.query || dedupedRecall.query),
    queryPreview: truncatePreview(input.query || rawRecall.query || dedupedRecall.query, 120),
    localEvidenceCount: countLocalMemoryEvidence(input.memoryContext),
    memos: {
      ...summarizeMemosRecall(dedupedRecall),
      usedBeforeDedupe: rawRecall.used === true,
      usedAfterDedupe: dedupedRecall.used === true,
      candidateCountBefore: normalizeArray(rawRecall.items).length,
      candidateCountAfter: normalizeArray(dedupedRecall.items).length,
      promptChars: normalizeText(input.memosRecallText || dedupedRecall.promptText).length,
      dedupe: {
        enabled: dedupedDedupe.enabled === true || rawDedupe.enabled === true,
        localEvidenceCount: Math.max(0, Number(dedupedDedupe.localEvidenceCount || rawDedupe.localEvidenceCount || 0) || 0),
        kept: Math.max(0, Number(dedupedDedupe.kept || normalizeArray(dedupedRecall.items).length || 0) || 0),
        removed: Math.max(0, Number(dedupedDedupe.removed || rawDedupe.removed || 0) || 0),
        removedItems: summarizeDedupedRemovedItems(dedupedDedupe)
      },
      rawItems: summarizeRecallItems(rawRecall.items),
      items: summarizeRecallItems(dedupedRecall.items)
    }
  });
}

function collectBlockIds(promptSnapshot = {}) {
  const snapshot = normalizeObject(promptSnapshot, {});
  return Array.from(new Set([
    ...normalizeArray(snapshot.stableBlockIds),
    ...normalizeArray(snapshot.dynamicBlockIds),
    ...normalizeArray(snapshot.assistantOnlyBlockIds),
    ...normalizeArray(snapshot.assembledBlocks).map((block) => normalizeText(block?.id))
  ].map((item) => normalizeText(item)).filter(Boolean)));
}

function summarizeTokenUsage(promptSnapshot = {}) {
  return normalizeArray(normalizeObject(promptSnapshot, {}).tokenUsageByBlock)
    .map((item) => ({
      id: normalizeText(item?.id || item?.blockId),
      label: normalizeText(item?.label),
      tokens: Math.max(0, Number(item?.tokens || item?.estimatedTokens || 0) || 0)
    }))
    .filter((item) => item.id || item.tokens > 0);
}

function summarizeTrimDecisions(promptSnapshot = {}) {
  return normalizeArray(normalizeObject(promptSnapshot, {}).trimDecisions)
    .map((item) => ({
      type: normalizeText(item?.type),
      blockId: normalizeText(item?.blockId),
      conflictTag: normalizeText(item?.conflictTag),
      keptBy: normalizeText(item?.keptBy),
      estimatedTokens: Number.isFinite(Number(item?.estimatedTokens)) ? Number(item.estimatedTokens) : null,
      budgetTokens: Number.isFinite(Number(item?.budgetTokens)) ? Number(item.budgetTokens) : null
    }))
    .filter((item) => item.type || item.blockId);
}

function findPlannerDecisionForBlock(plan = {}, blockId = '') {
  const target = normalizeText(blockId);
  if (!target) return null;
  return normalizeArray(normalizeObject(plan, {}).blockDecisions)
    .find((item) => normalizeText(item?.blockId) === target) || null;
}

function recordMainPromptBlockObservation(input = {}) {
  const promptSnapshot = normalizeObject(input.promptSnapshot, {});
  const dynamicPromptPlan = normalizeObject(input.dynamicPromptPlan, {});
  const allBlockIds = collectBlockIds(promptSnapshot);
  const memosDecision = findPlannerDecisionForBlock(dynamicPromptPlan, 'memos_recall');
  appendObservation({
    ...baseLogFields(input),
    stage: normalizeText(input.stage, 'prepare_main_prompt_blocks'),
    prompt: {
      stableBlockIds: normalizeArray(promptSnapshot.stableBlockIds).map((item) => normalizeText(item)).filter(Boolean),
      dynamicBlockIds: normalizeArray(promptSnapshot.dynamicBlockIds).map((item) => normalizeText(item)).filter(Boolean),
      assistantOnlyBlockIds: normalizeArray(promptSnapshot.assistantOnlyBlockIds).map((item) => normalizeText(item)).filter(Boolean),
      assembledBlockCount: normalizeArray(promptSnapshot.assembledBlocks).length,
      hasMemosRecall: allBlockIds.includes('memos_recall') || allBlockIds.includes('memos_recall_compact'),
      hasRetrievedMemoryLite: allBlockIds.includes('retrieved_memory_lite') || allBlockIds.includes('retrieved_memory_compact'),
      hasShortTermContinuity: allBlockIds.includes('short_term_continuity'),
      hasContinuityState: allBlockIds.includes('continuity_state') || allBlockIds.includes('session_continuity'),
      tokenUsageByBlock: summarizeTokenUsage(promptSnapshot),
      trimDecisions: summarizeTrimDecisions(promptSnapshot)
    },
    planner: {
      dynamicPromptPlanSource: normalizeText(dynamicPromptPlan.source || dynamicPromptPlan._source),
      enabledBlockIds: normalizeArray(dynamicPromptPlan.enabledBlockIds).map((item) => normalizeText(item)).filter(Boolean),
      memosRecallDecision: memosDecision
        ? {
            decision: normalizeText(memosDecision.decision),
            confidence: Number.isFinite(Number(memosDecision.confidence)) ? Number(memosDecision.confidence) : null,
            priority: Number.isFinite(Number(memosDecision.priority)) ? Number(memosDecision.priority) : null,
            reasonPreview: truncatePreview(memosDecision.reason, 120)
          }
        : null
    },
    localMemory: {
      evidenceCount: countLocalMemoryEvidence(input.memoryContext),
      cacheHit: Boolean(input.memoryContext?.cacheMeta?.hit)
    },
    memos: summarizeMemosRecall(input.memosRecall)
  });
}

function flushMemoryRecallObservabilitySync() {
  try {
    return flushBatchedLogWritesSync(resolveObservabilityLogFile());
  } catch (_) {
    return false;
  }
}

module.exports = {
  countLocalMemoryEvidence,
  flushMemoryRecallObservabilitySync,
  recordMainPromptBlockObservation,
  recordMemosPlannerRecallObservation,
  resolveObservabilityLogFile,
  stableHash,
  summarizeMemosRecall,
  summarizeRecallItems,
  truncatePreview
};
