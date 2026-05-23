const config = require('../../config');
const { trimTextByTokenBudget } = require('../contextBudget');

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function joinOrFallback(list, fallback = '暂无') {
  const values = Array.isArray(list) ? list.map((item) => sanitizeText(item)).filter(Boolean) : [];
  return values.length > 0 ? values.join('、') : fallback;
}

function formatProfile(profile) {
  if (!profile) return '暂无画像';

  return [
    `关系阶段：${profile.relation_stage || '陌生人'}`,
    `身份信息：${joinOrFallback(profile.identities)}`,
    `性格特征：${joinOrFallback(profile.personality_traits)}`,
    `爱好：${joinOrFallback(profile.hobbies)}`,
    `喜欢：${joinOrFallback(profile.likes)}`,
    `不喜欢：${joinOrFallback(profile.dislikes)}`,
    `目标：${joinOrFallback(profile.goals)}`,
    `最近话题：${joinOrFallback(profile.recent_topics)}`
  ].join('\n');
}

function formatImpression(impression) {
  const text = sanitizeText(impression);
  return text || '暂无明确用户印象';
}

function formatRetrievedMemories(hits, options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) {
    return String(options.emptyText || '暂无与当前问题强相关的长期记忆');
  }

  const showScore = options.showScore === true;
  const showReason = options.showReason === true;
  const showImportance = options.showImportance === true;
  const showStatus = options.showStatus !== false;
  const showSourceKind = options.showSourceKind === true;

  return list.map((hit, index) => {
    const parts = [String(hit.type || 'fact')];
    if (hit.tier) parts.push(`tier:${String(hit.tier).toUpperCase()}`);
    if (showStatus && hit.status) parts.push(`status:${hit.status}`);
    if (showSourceKind && hit.sourceKind) parts.push(`src:${hit.sourceKind}`);
    if (showImportance && hit.importance !== undefined) parts.push(`imp:${Number(hit.importance || 0).toFixed(2)}`);
    if (showScore && hit.score !== undefined) parts.push(`score:${Number(hit.score || 0).toFixed(3)}`);
    if (showReason && hit.reason) parts.push(String(hit.reason));
    return `${index + 1}. [${parts.join('|')}] ${hit.text}`;
  }).join('\n');
}

function getPromptTokenLimit(name, fallback) {
  return Math.max(0, Number(config[name] || fallback) || fallback || 0);
}

function limitPromptText(text, tokenBudget, strategy = 'tail') {
  const value = String(text || '').trim();
  if (!value) return '';
  const budget = Math.max(0, Number(tokenBudget) || 0);
  if (budget <= 0) return '';
  return trimTextByTokenBudget(value, budget, strategy);
}

function clampPromptMessage(label, text, tokenBudget, strategy = 'tail') {
  const body = limitPromptText(text, tokenBudget, strategy);
  if (!body) return [];
  return [{
    role: 'system',
    content: `[${label}]\n${body}`
  }];
}

function compactFactText(factText, maxLines = 8) {
  const lines = String(factText || '')
    .split(/\r?\n/)
    .map((line) => sanitizeText(line))
    .filter(Boolean);

  if (lines.length === 0) return '目前没有特别记忆。';
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

function formatStyleSignal(hit) {
  const text = String(hit?.text || '').replace(/^style:\s*/i, '').trim();
  return text ? `- User style: ${text}` : '';
}

function formatJargonSignal(hit) {
  const text = String(hit?.text || '').replace(/^group jargon:\s*/i, '').trim();
  return text ? `- Group jargon: ${text}` : '';
}

function estimateTraceTokens(text = '') {
  const raw = String(text || '');
  if (!raw) return 0;
  return Math.ceil(raw.length / 4);
}

function classifyRecallHitForPrompt(hit = {}) {
  const score = Number(hit.score || 0);
  const strongMin = Number(config.MEMORY_STRONG_RECALL_MIN_SCORE ?? 0.2);
  const weakMin = Number(config.MEMORY_WEAK_RECALL_MIN_SCORE ?? 0.08);
  if (score >= strongMin) return 'strong';
  if (score >= weakMin) return 'weak';
  return 'background';
}

function buildMemoryTrace({ hits = [], injected = {}, options = {} } = {}) {
  if (!config.MEMORY_TRACE_ENABLED) return null;
  const profileTrace = options.memoryProfileTrace && typeof options.memoryProfileTrace === 'object'
    ? options.memoryProfileTrace
    : {};
  const injectedEntries = Object.entries(injected || {}).map(([name, text]) => ({
    name,
    chars: String(text || '').length,
    approxTokens: estimateTraceTokens(text),
    preview: String(text || '').slice(0, 180)
  })).filter((item) => item.chars > 0);
  const injectedTokens = injectedEntries.reduce((sum, item) => sum + item.approxTokens, 0);
  const injectedBlockIds = Array.isArray(options.injectedBlockIds)
    ? options.injectedBlockIds.map((item) => sanitizeText(item)).filter(Boolean)
    : injectedEntries.map((item) => item.name).filter(Boolean);
  const droppedReasons = Array.isArray(options.droppedReasons)
    ? options.droppedReasons.map((item) => sanitizeText(item)).filter(Boolean)
    : [];
  const topHitIds = (Array.isArray(hits) ? hits : [])
    .map((hit) => String(hit.id || ''))
    .filter(Boolean)
    .slice(0, 8);
  return {
    enabled: true,
    strictPromptInjection: Boolean(config.MEMORY_STRICT_PROMPT_INJECTION_ENABLED),
    retrieval_path: sanitizeText(options.retrievalPath || options.retrieval_path || 'none'),
    retrieved_count: Array.isArray(hits) ? hits.length : 0,
    injected_block_ids: injectedBlockIds,
    dropped_reasons: droppedReasons,
    top_hit_ids: topHitIds,
    groupId: sanitizeText(options.groupId),
    routePolicyKey: sanitizeText(options.routePolicyKey),
    topRouteType: sanitizeText(options.topRouteType),
    hits: (Array.isArray(hits) ? hits : []).map((hit) => ({
      id: String(hit.id || ''),
      type: String(hit.type || hit.memoryKind || ''),
      source: String(hit.source || hit.sourceKind || hit.meta?.sourceKind || ''),
      sourceKind: String(hit.sourceKind || hit.meta?.sourceKind || ''),
      category: String(hit.category || hit.meta?.category || hit.payload?.category || ''),
      tags: Array.isArray(hit.tags) ? hit.tags.slice(0, 8).map((item) => sanitizeText(item)).filter(Boolean) : [],
      intent: String(hit.intent || hit.meta?.intent || hit.payload?.intent || ''),
      privacyLevel: String(hit.privacyLevel || hit.meta?.privacyLevel || hit.payload?.privacyLevel || ''),
      status: String(hit.status || ''),
      lifecycleStatus: String(hit.lifecycleStatus || hit.meta?.lifecycleStatus || hit.payload?.lifecycleStatus || ''),
      scopeType: String(hit.scopeType || ''),
      groupId: String(hit.groupId || ''),
      score: Number(hit.score || 0),
      tier: classifyRecallHitForPrompt(hit),
      finalTier: classifyRecallHitForPrompt(hit),
      decayScore: Number(hit.decayScore || 0),
      rehearsalBoost: Number(hit.rehearsalBoost || 0),
      memoryStrength: Number(hit.memoryStrength || 0),
      forgettingReason: String(hit.forgettingReason || ''),
      traceReason: String(hit.traceReason || hit.reason || hit.meta?.traceReason || ''),
      selectionReason: String(hit.selectionReason || ''),
      matchMode: String(hit.matchMode || ''),
      injected: classifyRecallHitForPrompt(hit) === 'strong' || !config.MEMORY_STRICT_PROMPT_INJECTION_ENABLED,
      preview: String(hit.text || '').slice(0, 180)
    })),
    injected: injectedEntries,
    injectedApproxTokens: injectedTokens,
    profile_source: String(profileTrace.profile_source || profileTrace.source || ''),
    profile_injected: Boolean(profileTrace.profile_injected),
    profile_trace_items: Array.isArray(profileTrace.traceItems) ? profileTrace.traceItems.slice(0, 12) : [],
    profile_conflicts: Array.isArray(profileTrace.conflicts) ? profileTrace.conflicts.slice(0, 12) : [],
    profile_suppressed: Array.isArray(profileTrace.suppressed) ? profileTrace.suppressed.slice(0, 12) : [],
    profile_expires_soon: Array.isArray(profileTrace.expiresSoon) ? profileTrace.expiresSoon.slice(0, 12) : [],
    legacy_fallback_used: Boolean(profileTrace.legacyFallbackUsed || profileTrace.legacy_fallback_used),
    legacy_fallback_disabled: Boolean(profileTrace.legacy_fallback_disabled),
    profile_disabled_reason: String(profileTrace.profile_disabled_reason || profileTrace.reason || '')
  };
}

function resolveInjectedBlockIds(injected = {}) {
  const map = {
    retrievedMemory: 'retrieved_memory_lite',
    weakEvidence: 'retrieved_memory_lite',
    styleSignals: 'retrieved_memory_lite',
    taskMemory: 'retrieved_memory_lite',
    groupMemory: 'retrieved_memory_lite',
    dailyJournal: 'daily_journal',
    longTermProfile: 'long_term_profile'
  };
  return Array.from(new Set(Object.entries(injected || {})
    .filter(([, text]) => String(text || '').trim())
    .map(([key]) => map[key] || key)
    .filter(Boolean)));
}

function resolveDroppedReasons(hits = [], injected = {}, extra = []) {
  const reasons = Array.isArray(extra) ? extra.map((item) => sanitizeText(item)).filter(Boolean) : [];
  const hitCount = Array.isArray(hits) ? hits.length : 0;
  const hasRetrieved = Boolean(String(injected?.retrievedMemory || '').trim());
  const hasAnyInjected = Object.values(injected || {}).some((text) => String(text || '').trim());
  if (hitCount > 0 && !hasAnyInjected) reasons.push('retrieved_but_not_injected');
  if (hitCount > 0 && !hasRetrieved && !String(injected?.weakEvidence || '').trim()) reasons.push('no_retrieved_memory_text');
  return Array.from(new Set(reasons));
}

module.exports = {
  buildMemoryTrace,
  clampPromptMessage,
  classifyRecallHitForPrompt,
  compactFactText,
  formatImpression,
  formatJargonSignal,
  formatProfile,
  formatRetrievedMemories,
  formatStyleSignal,
  getPromptTokenLimit,
  limitPromptText,
  resolveDroppedReasons,
  resolveInjectedBlockIds,
  sanitizeText
};
