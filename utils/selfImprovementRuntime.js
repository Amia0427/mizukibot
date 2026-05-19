const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { sanitizeUntrustedContent } = require('./promptSecurity');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('./perfRuntime');
const {
  appendJsonLine,
  atomicWriteJson,
  ensureStore,
  getStorePaths,
  safeReadJson,
  safeReadText,
  safeWriteText
} = require('./selfImprovement/storeFiles');
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

function readEvents() {
  const paths = ensureStore();
  const raw = safeReadText(paths.eventsFile, '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .map((item) => normalizeStoredEvent(item));
}

function readPatterns() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.patternsFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
  };
}

function readPromotedRules() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.rulesFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
  };
}

function readSkillGuides() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.guidesFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
  };
}

function writeEvents(events = []) {
  const paths = ensureStore();
  const body = normalizeArray(events).map((item) => JSON.stringify(normalizeStoredEvent(item))).join('\n');
  safeWriteText(paths.eventsFile, body ? `${body}\n` : '');
}

function writePatterns(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.patternsFile, {
    items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
  });
}

function writePromotedRules(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.rulesFile, {
    items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
  });
}

function writeSkillGuides(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.guidesFile, {
    items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
  });
}

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

function getExtractionApiBaseUrl() {
  return String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getExtractionApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function getExtractionModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  return String(content || '');
}

function extractJsonSafely(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fenced ? String(fenced[1] || '').trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function buildExtractionPrompt() {
  return [
    'You extract reusable self-improvement events from a single successful assistant turn.',
    'Return JSON only with shape:',
    '{',
    '  "items": [',
    '    {',
    '      "kind": "error|correction|feature_request|strategy|knowledge_gap",',
    '      "pattern_key": "",',
    '      "summary": "",',
    '      "details": "",',
    '      "suggested_action": "",',
    '      "confidence": 0.0,',
    '      "priority": 0.0,',
    '      "evidence": ["", "", ""]',
    '    }',
    '  ]',
    '}',
    'Rules:',
    '- Prefer strategy when the turn demonstrates a reusable successful tactic.',
    '- Use knowledge_gap only for missing knowledge that limited quality.',
    '- Keep each summary short and generalizable.',
    '- At most 3 items.',
    '- If nothing reusable exists, return {"items":[]}.'
  ].join('\n');
}

function buildExtractionConversation(userText, botReply, options = {}) {
  const routeContext = normalizeRouteContext(options);
  const execLogs = normalizeArray(options.execLogs).slice(0, 6).map((item) => ({
    action: trimText(item.action || '', 80),
    purpose: redactSensitiveText(item.purpose || '', 120),
    ok: Boolean(item.ok),
    result: redactSensitiveText(item.result || '', 180),
    error: redactSensitiveText(item.error || '', 180)
  }));
  return [
    `User: ${redactSensitiveText(userText, 1200)}`,
    `Assistant: ${redactSensitiveText(botReply, 1600)}`,
    `RoutePolicyKey: ${routeContext.routePolicyKey}`,
    `TopRouteType: ${routeContext.topRouteType}`,
    `TaskType: ${routeContext.taskType}`,
    `ToolName: ${routeContext.toolName}`,
    `ExecLogs: ${JSON.stringify(execLogs)}`
  ].join('\n');
}

async function learnSelfImprovement(userId, userText, botReply, options = {}) {
  if (!ensureEnabled() || !config.SELF_IMPROVEMENT_EXTRACTION_ENABLED) return [];
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'self_improvement_deferred',
      delayMs: pressureDelayMs,
      userId: trimText(userId, 120)
    });
    return [];
  }
  const uid = trimText(userId, 120);
  const question = trimText(userText, 2000);
  const answer = trimText(botReply, 3000);
  if (!uid || !question || !answer) return [];
  if (shouldBlockSelfImprovementText(`${question}\n${answer}`).blocked) return [];

  const apiBaseUrl = getExtractionApiBaseUrl();
  const apiKey = getExtractionApiKey();
  if (!apiBaseUrl || !apiKey) return [];

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(apiBaseUrl),
      {
        model: getExtractionModelName(),
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: buildExtractionPrompt() },
          { role: 'user', content: buildExtractionConversation(question, answer, options) }
        ],
        max_tokens: 360,
        stream: false,
        __trace: {
          source: 'self_improvement',
          phase: 'extract',
          purpose: 'self_improvement_learning',
          userId: uid,
          routePolicyKey: trimText(options.routePolicyKey || '', 120),
          topRouteType: trimText(options.topRouteType || '', 80)
        }
      },
      1,
      apiKey
    );
    const msg = extractMessageContent(resp);
    const parsed = extractJsonSafely(normalizeTextContent(msg?.content));
    const items = normalizeArray(parsed?.items).slice(0, 3);
    const stored = [];
    for (const raw of items) {
      const item = normalizeObject(raw, {});
      const confidence = clampNumber(item.confidence, 0, 1, 0);
      if (confidence < Number(config.SELF_IMPROVEMENT_EXTRACT_MIN_CONFIDENCE || 0.78)) continue;
      const event = appendEvent({
        kind: item.kind,
        source: 'llm_extraction',
        status: 'open',
        patternKey: item.pattern_key || item.patternKey || options.taskType || options.routePolicyKey || 'strategy',
        priority: clampNumber(item.priority, 0, 1, derivePriority(normalizeKind(item.kind))),
        summary: sanitizeUntrustedContent(item.summary, 'self_improvement'),
        details: sanitizeUntrustedContent(item.details, 'self_improvement'),
        suggestedAction: sanitizeUntrustedContent(item.suggested_action || item.suggestedAction, 'self_improvement'),
        confidence,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        toolName: options.toolName,
        taskType: options.taskType,
        sessionId: options.sessionId,
        channelId: options.channelId,
        groupId: options.groupId,
        userId: uid,
        evidence: normalizeArray(item.evidence).map((entry) => ({ excerpt: sanitizeUntrustedContent(entry, 'self_improvement') }))
      });
      if (event) stored.push(event);
    }
    return stored;
  } catch (error) {
    console.error('[self-improvement] async extraction failed:', error?.message || error);
    if (options.throwOnError) throw error;
    return [];
  }
}

function storeExtractedSelfImprovementItems(userId, items = [], options = {}) {
  const uid = trimText(userId, 120);
  if (!uid) return [];
  const stored = [];
  for (const raw of normalizeArray(items).slice(0, 3)) {
    const item = normalizeObject(raw, {});
    const confidence = clampNumber(item.confidence, 0, 1, 0);
    if (confidence < Number(config.SELF_IMPROVEMENT_EXTRACT_MIN_CONFIDENCE || 0.78)) continue;
    const event = appendEvent({
      kind: item.kind,
      source: 'llm_extraction',
      status: 'open',
      patternKey: item.pattern_key || item.patternKey || options.taskType || options.routePolicyKey || 'strategy',
      priority: clampNumber(item.priority, 0, 1, derivePriority(normalizeKind(item.kind))),
      summary: sanitizeUntrustedContent(item.summary, 'self_improvement'),
      details: sanitizeUntrustedContent(item.details, 'self_improvement'),
      suggestedAction: sanitizeUntrustedContent(item.suggested_action || item.suggestedAction, 'self_improvement'),
      confidence,
      routePolicyKey: options.routePolicyKey,
      topRouteType: options.topRouteType,
      toolName: options.toolName,
      taskType: options.taskType,
      sessionId: options.sessionId,
      channelId: options.channelId,
      groupId: options.groupId,
      userId: uid,
      evidence: normalizeArray(item.evidence).map((entry) => ({ excerpt: sanitizeUntrustedContent(entry, 'self_improvement') }))
    });
    if (event) stored.push(event);
  }
  return stored;
}

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

  const prefer = [];
  const avoid = [];
  for (const item of candidates) {
    const text = trimText(item.ruleText || item.runtimeRule || item.injectionText || buildRuntimeRule(item).ruleText, 220);
    if (!text) continue;
    if (/^Prefer:/i.test(text)) prefer.push(text.replace(/^Prefer:\s*/i, ''));
    else avoid.push(text.replace(/^Avoid:\s*/i, ''));
  }
  if (prefer.length === 0 && avoid.length === 0) return '';
  const lines = ['[SelfImprovement]'];
  if (prefer.length > 0) lines.push(`Prefer: ${prefer.join(' | ')}`);
  if (avoid.length > 0) lines.push(`Avoid: ${avoid.join(' | ')}`);
  return trimText(lines.join('\n'), maxChars);
}

function formatEventsAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement events found.';
  return list.map((item, index) => {
    const status = item.status === PROMOTED_STATUS ? 'promoted' : item.status;
    const meta = [item.kind, status, item.patternKey].filter(Boolean).join(' | ');
    const detail = [item.summary, item.suggestedAction ? `action: ${item.suggestedAction}` : ''].filter(Boolean).join(' | ');
    return `${index + 1}. [${meta}] ${detail}`;
  }).join('\n');
}

function formatPatternsAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement patterns found.';
  return list.map((item, index) => {
    const prefix = `${index + 1}. [${item.kind} | ${item.status} | count:${item.occurrenceCount}]`;
    const body = [item.patternKey, item.summary, item.runtimeRule || item.injectionText].filter(Boolean).join(' | ');
    return `${prefix} ${body}`.trim();
  }).join('\n');
}

function formatRulesAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement rules found.';
  return list.map((item, index) => {
    const meta = [item.kind, item.ruleType, `count:${item.occurrenceCount}`, item.patternKey].filter(Boolean).join(' | ');
    return `${index + 1}. [${meta}] ${item.ruleText}`;
  }).join('\n');
}

function formatGuidesAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement guides found.';
  return list.map((item, index) => {
    const hints = normalizeArray(item.triggerHints).join(', ');
    const dos = normalizeArray(item.doList).join(' | ');
    const donts = normalizeArray(item.dontList).join(' | ');
    return [
      `${index + 1}. [${item.kind} | ${item.patternKey}] ${item.title}`,
      item.summary ? `summary: ${item.summary}` : '',
      item.ruleText ? `rule: ${item.ruleText}` : '',
      hints ? `triggers: ${hints}` : '',
      dos ? `do: ${dos}` : '',
      donts ? `avoid: ${donts}` : '',
      item.example ? `example: ${item.example}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');
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
  searchEvents
};
