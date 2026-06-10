const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { sanitizeUntrustedContent } = require('./promptSecurity');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('./perfRuntime');
const {
  appendJsonLine,
  ensureStore,
  getStorePaths
} = require('./selfImprovement/storeFiles');
const { createSelfImprovementAccessors } = require('./selfImprovement/accessors');
const { createPatternEngine } = require('./selfImprovement/patternEngine');
const {
  clampNumber,
  derivePriority,
  hashShort,
  normalizeArray,
  normalizeEvidenceList,
  normalizeKeyPart,
  normalizeKind,
  normalizeLowerText,
  normalizeObject,
  normalizePatternKey,
  normalizeRouteContext,
  normalizeStatus,
  normalizeSummary,
  parseTime,
  redactSensitiveText,
  trimText
} = require('./selfImprovement/normalizers');
const {
  canonicalizePatternKey,
  detectCapabilityIssue,
  detectResponseIssue,
  detectToolIssue,
  normalizeGuideRecord,
  normalizePatternRecord,
  normalizePromptSource,
  normalizeRuleRecord,
  normalizeStoredEvent,
  shouldBlockSelfImprovementText
} = require('./selfImprovement/recordTransforms');
const { createSelfImprovementExtraction } = require('./selfImprovement/extraction');
const { createSelfImprovementFormatters } = require('./selfImprovement/formatters');

const PROMOTED_STATUS = 'promoted';
const GUIDE_ACTIVE_STATUS = 'active';
let cachedTaskMemoryBridge = undefined;

const {
  buildRuntimeRule,
  findDedupMatch,
  mergeEvent,
  recomputePatterns,
  rebuildLocalSkillGuides,
  rebuildPromotedRules
} = createPatternEngine({
  normalizeGuideRecord,
  normalizePatternRecord,
  normalizeRuleRecord,
  normalizeStoredEvent
});

const {
  readEvents,
  readPatterns,
  readPromotedRules,
  readSkillGuides,
  writeEvents,
  writePatterns,
  writePromotedRules,
  writeSkillGuides
} = createSelfImprovementAccessors({
  normalizeArray,
  normalizeGuideRecord,
  normalizePatternRecord,
  normalizeRuleRecord,
  normalizeStoredEvent
});

const {
  collectPromptRuleLines,
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText
} = createSelfImprovementFormatters({
  buildRuntimeRule,
  normalizeArray
});

function ensureEnabled() {
  return Boolean(config.SELF_IMPROVEMENT_ENABLED);
}

function getTaskMemoryBridge() {
  if (cachedTaskMemoryBridge !== undefined) return cachedTaskMemoryBridge;
  try {
    const mod = require('./taskMemory');
    cachedTaskMemoryBridge = typeof mod?.addTaskMemory === 'function' ? mod.addTaskMemory : null;
  } catch (error) {
    cachedTaskMemoryBridge = null;
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    console.warn('[self-improvement] taskMemory bridge unavailable:', error.message);
  }
  return cachedTaskMemoryBridge;
}

function maybeBridgeTaskMemory(event = {}) {
  if (!config.TASK_MEMORY_ENABLED) return null;
  const normalized = normalizeStoredEvent(event);
  const actionable = trimText(normalized.suggestedAction || '', 220);
  const shouldBridge = normalized.kind === 'strategy'
    || ((normalized.kind === 'error' || normalized.kind === 'correction') && normalized.status === PROMOTED_STATUS && actionable);
  if (!shouldBridge) return null;
  if (!normalized.userId || !actionable) return null;
  const addTaskMemory = getTaskMemoryBridge();
  if (typeof addTaskMemory !== 'function') return null;
  return addTaskMemory(normalized.userId, {
    taskType: normalized.taskType || normalized.patternKey || normalized.kind,
    trigger: normalized.summary,
    strategy: normalized.kind === 'strategy' ? actionable : '',
    avoid: normalized.kind === 'strategy' ? '' : normalized.summary,
    outcome: normalized.kind === 'strategy' ? 'success' : 'failure',
    confidence: normalized.confidence || 0.8,
    source: 'self_improvement',
    routePolicyKey: normalized.routePolicyKey,
    topRouteType: normalized.topRouteType,
    toolName: normalized.toolName,
    sessionId: normalized.sessionId,
    channelId: normalized.channelId
  });
}

function appendEvent(input = {}) {
  if (!ensureEnabled()) return null;
  const events = readEvents();
  const normalized = normalizeStoredEvent(input);
  const dedupIndex = findDedupMatch(events, normalized);
  if (dedupIndex >= 0) {
    events[dedupIndex] = mergeEvent(events[dedupIndex], normalized);
  } else {
    appendJsonLine(getStorePaths().eventsFile, normalized);
    events.push(normalized);
  }
  const recomputed = recomputePatterns(events);
  writeEvents(recomputed.events);
  writePatterns({ items: recomputed.patterns });
  writePromotedRules({ items: recomputed.promotedRules });
  writeSkillGuides({ items: recomputed.skillGuides });
  const finalEvent = recomputed.events.find((item) => String(item.id) === String(normalized.id))
    || recomputed.events[dedupIndex >= 0 ? dedupIndex : recomputed.events.length - 1]
    || normalized;
  maybeBridgeTaskMemory(finalEvent);
  return finalEvent;
}

function sanitizeToolFailureResult(result = '') {
  const text = redactSensitiveText(result, 240);
  return text.replace(/^Tool error:\s*/i, '').replace(/^Unknown tool:\s*/i, '').replace(/^Tool not allowed:\s*/i, '').trim() || text;
}

function captureToolFailure(input = {}) {
  const envelope = normalizeObject(input.envelope, {});
  const routeContext = normalizeRouteContext(input);
  const summary = normalizeSummary(input.summary || `${envelope.tool_name || routeContext.toolName || 'tool'} failed`);
  const errorText = sanitizeToolFailureResult(envelope.result || input.error || '');
  return appendEvent({
    kind: 'error',
    source: 'deterministic_tool_error',
    status: 'open',
    patternKey: input.patternKey || `tool.${normalizeKeyPart(envelope.tool_name || routeContext.toolName || 'unknown', 'unknown')}.${detectToolIssue(summary, input.details || input.purpose || '', errorText) || `other_${hashShort(summary)}`}`,
    priority: derivePriority('error'),
    summary,
    details: input.details || input.purpose || '',
    suggestedAction: input.suggestedAction || redactSensitiveText(input.fallbackAction || '', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.92),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: trimText(envelope.tool_name || routeContext.toolName || '', 80),
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'purpose', excerpt: redactSensitiveText(input.purpose || '', 180) },
      { label: 'error', excerpt: errorText },
      ...(normalizeArray(input.evidence))
    ])
  });
}

function captureCorrection(input = {}) {
  const routeContext = normalizeRouteContext(input);
  const userMessage = redactSensitiveText(input.userMessage || '', 220);
  const assistantReply = redactSensitiveText(input.assistantReply || '', 220);
  return appendEvent({
    kind: 'correction',
    source: 'deterministic_correction',
    status: 'open',
    patternKey: input.patternKey || `response.${normalizeKeyPart(routeContext.topRouteType || 'direct_chat', 'direct_chat')}.${detectResponseIssue(userMessage, assistantReply, '') || 'fact_incorrect'}`,
    priority: derivePriority('correction'),
    summary: normalizeSummary(input.summary || userMessage || 'user corrected the assistant'),
    details: redactSensitiveText(input.details || assistantReply, 420),
    suggestedAction: redactSensitiveText(input.suggestedAction || 'Double-check the corrected fact before answering similar requests.', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.86),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: routeContext.toolName,
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'assistant_reply', excerpt: assistantReply },
      { label: 'user_correction', excerpt: userMessage }
    ])
  });
}

function captureFeatureRequest(input = {}) {
  const routeContext = normalizeRouteContext(input);
  const summary = normalizeSummary(input.summary || input.userMessage || 'capability requested but unavailable');
  return appendEvent({
    kind: 'feature_request',
    source: 'deterministic_feature_request',
    status: 'open',
    patternKey: input.patternKey || `capability.${normalizeKeyPart(routeContext.topRouteType || routeContext.taskType || 'general', 'general')}.${detectCapabilityIssue(summary, input.details || input.unavailableReason || '', routeContext) || 'route_missing_capability'}`,
    priority: derivePriority('feature_request'),
    summary,
    details: redactSensitiveText(input.details || input.unavailableReason || '', 420),
    suggestedAction: redactSensitiveText(input.suggestedAction || input.requestedCapability || '', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.84),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: routeContext.toolName,
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'request', excerpt: redactSensitiveText(input.userMessage || '', 180) },
      { label: 'reason', excerpt: redactSensitiveText(input.unavailableReason || '', 180) }
    ])
  });
}

const {
  learnSelfImprovement,
  storeExtractedSelfImprovementItems
} = createSelfImprovementExtraction({
  appendEvent,
  appendPerfEvent,
  clampNumber,
  config,
  derivePriority,
  ensureEnabled,
  extractMessageContent,
  getBackgroundPressureDelayMs,
  normalizeArray,
  normalizeKind,
  normalizeObject,
  normalizeRouteContext,
  postWithRetry,
  redactSensitiveText,
  sanitizeUntrustedContent,
  shouldBlockSelfImprovementText,
  trimText
});

function listRecentEvents(limit = 10, filters = {}) {
  return readEvents()
    .filter((item) => !filters.kind || item.kind === normalizeKind(filters.kind))
    .filter((item) => !filters.status || item.status === normalizeStatus(filters.status))
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function searchEvents(query = '', options = {}) {
  const q = normalizeLowerText(query, 200);
  const queryTerms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const promotedOnly = Boolean(options.promotedOnly || options.promoted_only);
  const kind = options.kind ? normalizeKind(options.kind) : '';
  const topK = Math.max(1, Math.min(20, Number(options.topK || options.top_k || 5) || 5));
  return readEvents()
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !promotedOnly || item.status === PROMOTED_STATUS)
    .map((item) => {
      const haystack = `${item.summary} ${item.details} ${item.suggestedAction} ${item.patternKey}`.toLowerCase();
      const matchCount = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      const recency = parseTime(item.updatedAt) / 1e12;
      const score = matchCount * 8 + Number(item.occurrenceCount || 0) + Number(item.confidence || 0) * 4 + recency;
      return { ...item, _score: score };
    })
    .filter((item) => !queryTerms.length || item._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK)
    .map(({ _score, ...item }) => item);
}

function listPatterns(limit = 10, filters = {}) {
  const routePolicyKey = trimText(filters.routePolicyKey || filters.route_policy_key || '', 120);
  const toolName = trimText(filters.toolName || filters.tool_name || '', 80);
  return readPatterns().items
    .filter((item) => !filters.kind || item.kind === normalizeKind(filters.kind))
    .filter((item) => !filters.status || item.status === normalizeStatus(filters.status))
    .filter((item) => !routePolicyKey || item.routePolicyKey === routePolicyKey)
    .filter((item) => !toolName || item.toolName === toolName)
    .sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function listRules(limit = 10, filters = {}) {
  const patternKey = trimText(filters.patternKey || filters.pattern_key || '', 120);
  const routePolicyKey = trimText(filters.routePolicyKey || filters.route_policy_key || '', 120);
  const topRouteType = trimText(filters.topRouteType || filters.top_route_type || '', 80);
  const toolName = trimText(filters.toolName || filters.tool_name || '', 80);
  return readPromotedRules().items
    .filter((item) => !patternKey || item.patternKey === normalizePatternKey(patternKey))
    .filter((item) => !routePolicyKey || item.routePolicyKey === routePolicyKey)
    .filter((item) => !topRouteType || item.topRouteType === topRouteType)
    .filter((item) => !toolName || item.toolName === toolName)
    .sort((a, b) => parseTime(b.sourcePatternUpdatedAt) - parseTime(a.sourcePatternUpdatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function listGuides(limit = 10, filters = {}) {
  const patternKey = trimText(filters.patternKey || filters.pattern_key || '', 120);
  const activeOnly = filters.activeOnly === undefined ? Boolean(filters.active_only ?? true) : Boolean(filters.activeOnly);
  return readSkillGuides().items
    .filter((item) => !patternKey || item.patternKey === normalizePatternKey(patternKey))
    .filter((item) => !activeOnly || item.status === GUIDE_ACTIVE_STATUS)
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function scorePatternLike(entry = {}, query = {}) {
  let score = 0;
  if (query.toolName && entry.toolName && query.toolName === entry.toolName) score += 50;
  if (query.routePolicyKey && entry.routePolicyKey && query.routePolicyKey === entry.routePolicyKey) score += 35;
  if (query.topRouteType && entry.topRouteType && query.topRouteType === entry.topRouteType) score += 20;
  if (query.queryTerms.length > 0) {
    const haystack = `${entry.summary || ''} ${entry.suggestedAction || ''} ${entry.patternKey || ''} ${entry.ruleText || ''}`.toLowerCase();
    const matches = query.queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    score += matches * 6;
  }
  score += Math.min(10, Number(entry.occurrenceCount || 0));
  score += Number(entry.confidence || 0) * 5;
  score += parseTime(entry.lastSeenAt || entry.sourcePatternUpdatedAt || entry.updatedAt) / 1e12;
  return score;
}

function buildPromptSnippet(input = {}) {
  if (!ensureEnabled() || !config.SELF_IMPROVEMENT_PROMPT_ENABLED) return '';
  const topK = Math.max(1, Math.min(10, Number(input.topK || config.SELF_IMPROVEMENT_PROMPT_TOP_K || 3)));
  const maxChars = Math.max(120, Number(input.maxChars || config.SELF_IMPROVEMENT_PROMPT_MAX_CHARS || 900));
  const queryTerms = normalizeLowerText(input.query || '', 240).split(/\s+/).filter(Boolean).slice(0, 8);
  const query = {
    toolName: trimText(input.toolName || '', 80),
    routePolicyKey: trimText(input.routePolicyKey || '', 120),
    topRouteType: trimText(input.topRouteType || '', 80),
    queryTerms
  };
  const promptSource = normalizePromptSource(config.SELF_IMPROVEMENT_PROMPT_SOURCE);
  const baseCandidates = promptSource === 'patterns'
    ? readPatterns().items.filter((item) => item.status === PROMOTED_STATUS)
    : readPromotedRules().items;
  const candidates = baseCandidates
    .map((item) => ({ ...item, _score: scorePatternLike(item, query) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);
  if (candidates.length === 0) return '';

  const { prefer, avoid } = collectPromptRuleLines(candidates, { trimText });
  if (prefer.length === 0 && avoid.length === 0) return '';
  const lines = ['[SelfImprovement]'];
  if (prefer.length > 0) lines.push(`Prefer: ${prefer.join(' | ')}`);
  if (avoid.length > 0) lines.push(`Avoid: ${avoid.join(' | ')}`);
  return trimText(lines.join('\n'), maxChars);
}

module.exports = {
  appendEvent,
  buildPromptSnippet,
  canonicalizePatternKey,
  captureCorrection,
  captureFeatureRequest,
  captureToolFailure,
  ensureStore,
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText,
  learnSelfImprovement,
  storeExtractedSelfImprovementItems,
  listGuides,
  listPatterns,
  listRecentEvents,
  listRules,
  normalizePatternKey,
  readEvents,
  readPatterns,
  readPromotedRules,
  readSkillGuides,
  recomputePatterns,
  rebuildLocalSkillGuides,
  rebuildPromotedRules,
  searchEvents,
  writeEvents,
  writePatterns,
  writePromotedRules,
  writeSkillGuides
};
