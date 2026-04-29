const config = require('../config');
const {
  getUserMemories,
  getUserProfile,
  getUserSummary,
  getUserImpression,
  getUserAffinityState
} = require('./memory');
const {
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  getCoreMemories,
  getMemoryStats
} = require('./vectorMemory');
const {
  getAccessibleGroupIdsForUser
} = require('./memoryScopeIndex');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { formatGroupMemories } = require('./groupMemory');
const { formatTaskMemories } = require('./taskMemory');
const {
  classifyRecallFacet,
  isRecentRecallQuery
} = require('./recallHeuristics');
const {
  buildStableProfileText
} = require('./memoryProfileSurface');
const {
  trimTextByTokenBudget
} = require('./contextBudget');
const {
  queryMemory,
  assembleMemoryPacket
} = require('./memory-v3');
const {
  resolveJournalTargetDays
} = require('./memory-v3/journalDocs');
const { queryLocalKnowledge } = require('./localKnowledge');

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

function buildRouteMemoryFilter(options = {}) {
  return {
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType
  };
}

function resolveReadableGroupIds(userId = '', options = {}) {
  const explicitGroupIds = Array.isArray(options.groupIds)
    ? options.groupIds
    : [];
  const readableGroupIds = explicitGroupIds.length > 0
    ? explicitGroupIds
    : getAccessibleGroupIdsForUser(userId);
  const currentGroupId = sanitizeText(options.groupId);
  const deduped = [];
  const seen = new Set();

  for (const raw of [...readableGroupIds, currentGroupId]) {
    const groupId = sanitizeText(raw);
    if (!groupId || seen.has(groupId)) continue;
    seen.add(groupId);
    deduped.push(groupId);
  }

  deduped.sort();
  return deduped;
}

function buildUnifiedRecallOptions(options = {}) {
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(options.userId, options);
  return {
    ...buildRouteMemoryFilter(options),
    queryFacet: options.queryFacet || classifyRecallFacet(options.question || ''),
    taskType: options.taskType,
    agentName: options.agentName,
    toolName: options.toolName,
    sessionId: options.sessionId,
    channelId: options.channelId,
    participants: Array.isArray(options.participants) ? options.participants : [],
    groupId: options.groupId,
    groupIds: resolvedGroupIds,
    includeTask: true,
    includeGroup: resolvedGroupIds.length > 0,
    includeSignals: true,
    includeEpisodes: true
  };
}

function getRequestMemo(options = {}) {
  if (!options || typeof options !== 'object') return new Map();
  if (!(options.__memoryContextMemo instanceof Map)) {
    options.__memoryContextMemo = new Map();
  }
  return options.__memoryContextMemo;
}

function buildMemoKey(prefix, userId, question = '', options = {}) {
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(userId, options);
  const kindMask = [
    options.includeTask !== false ? 'task' : '',
    options.includeGroup !== false && options.groupId ? `group:${options.groupId}` : '',
    options.includeGroup !== false && resolvedGroupIds.length > 0 ? `groups:${resolvedGroupIds.join(',')}` : '',
    options.includeSignals !== false ? 'signals' : '',
    options.includeEpisodes !== false ? 'episodes' : '',
    options.memoryKind || '',
    Array.isArray(options.memoryKinds) ? options.memoryKinds.join(',') : '',
    sanitizeText(options.sessionId) ? `session:${sanitizeText(options.sessionId)}` : '',
    sanitizeText(options.channelId) ? `channel:${sanitizeText(options.channelId)}` : '',
    sanitizeText(options.sharedShortTermSignature) ? `shared:${sanitizeText(options.sharedShortTermSignature)}` : ''
  ].filter(Boolean).join('|') || 'default';
  const lookback = String(options.dailyLookbackDays || options.lookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS || '');
  const journalTarget = sanitizeText(options.dailyJournalTimestamp || options.dailyJournalYearMonth || '');
  const rawMode = options.includeActiveRaw ? 'active_raw' : '';
  return [
    prefix,
    sanitizeText(userId),
    sanitizeText(options.groupId),
    sanitizeText(options.taskType),
    sanitizeText(question),
    kindMask,
    lookback,
    journalTarget,
    rawMode
  ].join('|');
}

function memoizeValue(options, key, factory) {
  const memo = getRequestMemo(options);
  if (memo.has(key)) return memo.get(key);
  const value = factory();
  memo.set(key, value);
  return value;
}

function resolveDailyJournalTimestamp(question = '', options = {}) {
  const explicit = sanitizeText(options.dailyJournalTimestamp);
  if (explicit) return explicit;
  const targetDays = resolveJournalTargetDays(question, {
    today: options.journalToday,
    now: options.journalNow
  });
  return targetDays[0] || '';
}

function formatDailyJournalPromptItem(item = {}) {
  if (!item || !item.text) return '';
  if (item.kind === 'four_day_rollup') return `[4day ${item.startDay}..${item.endDay}]\n${item.text}`;
  if (item.kind === 'monthly_rollup') return `[month ${item.yearMonth} ${item.part || ''}]\n${item.text}`.trim();
  return `[${item.day || item.episodeDay || item.title || 'daily'}]\n${item.text}`;
}

function buildPromptJournalItems(bundle = {}) {
  const activeRaw = Array.isArray(bundle?.byLayer?.activeRaw) ? bundle.byLayer.activeRaw : [];
  const daily = Array.isArray(bundle?.byLayer?.daily) ? bundle.byLayer.daily : [];
  const fourDay = Array.isArray(bundle?.byLayer?.fourDay) ? bundle.byLayer.fourDay : [];
  const monthly = Array.isArray(bundle?.byLayer?.monthly) ? bundle.byLayer.monthly : [];
  if (activeRaw.length > 0) return activeRaw.concat(daily.slice(-1), fourDay.slice(-1), monthly.slice(-1));
  if (daily.length > 0) return daily.concat(fourDay.slice(-1), monthly.slice(-1));
  if (fourDay.length > 0) return fourDay.concat(monthly.slice(-1));
  return monthly;
}

function isStyleQuery(question = '', options = {}) {
  if (options.forceSignalRecall) return true;
  const text = sanitizeText(question).toLowerCase();
  if (!text) return false;
  return /(\bstyle\b|\btone\b|\bvoice\b|\bjargon\b|\bslang\b|\bphrase\b|\blike the user\b|\blike the group\b|语气|风格|说话方式|表达方式|口头禅|黑话|群话|群友|像本人|像群里)/i.test(text);
}

function normalizeSignalKey(hit = {}) {
  return sanitizeText(hit.canonicalText || hit.text || '').toLowerCase();
}

function getSignalInjectionState(options = {}) {
  if (!options || typeof options !== 'object') return {};
  if (!options.signalInjectionState || typeof options.signalInjectionState !== 'object') {
    options.signalInjectionState = {};
  }
  return options.signalInjectionState;
}

function getSessionSignalCache(options = {}) {
  const state = getSignalInjectionState(options);
  const scopeKey = sanitizeText(options.sessionId || options.channelId || options.groupId || options.userId || 'default') || 'default';
  if (!state[scopeKey] || typeof state[scopeKey] !== 'object') {
    state[scopeKey] = {};
  }
  return state[scopeKey];
}

function wasSignalRecentlyInjected(hit, options = {}) {
  const key = normalizeSignalKey(hit);
  if (!key) return false;
  const cache = getSessionSignalCache(options);
  const lastTs = Number(cache[key] || 0) || 0;
  if (!lastTs) return false;
  return (Date.now() - lastTs) < (48 * 3600 * 1000);
}

function markSignalsInjected(hits = [], options = {}) {
  const cache = getSessionSignalCache(options);
  const ts = Date.now();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const key = normalizeSignalKey(hit);
    if (!key) continue;
    cache[key] = ts;
  }
}

function formatStyleSignal(hit) {
  const text = String(hit?.text || '').replace(/^style:\s*/i, '').trim();
  return text ? `- User style: ${text}` : '';
}

function formatJargonSignal(hit) {
  const text = String(hit?.text || '').replace(/^group jargon:\s*/i, '').trim();
  return text ? `- Group jargon: ${text}` : '';
}

function splitUnifiedHits(allHits = [], options = {}) {
  const hits = Array.isArray(allHits) ? allHits : [];
  const factHits = hits.filter((hit) => hit.memoryKind !== 'style' && hit.memoryKind !== 'jargon');
  const styleHits = hits.filter((hit) => hit.memoryKind === 'style');
  const jargonHits = hits.filter((hit) => hit.memoryKind === 'jargon');
  const journalHits = factHits.filter((hit) => hit.type === 'episode' || hit.memoryKind === 'episode');
  const taskHits = factHits.filter((hit) => String(hit.scopeType || '') === 'task');
  const groupHits = factHits.filter((hit) => String(hit.scopeType || '') === 'group');
  const coreCandidates = memoizeValue(
    options,
    buildMemoKey('core', options.userId, options.question || '', options),
    () => getCoreMemories(options.userId, options.coreK || 6, {
      minTier: options.coreMinTier || 'A'
    })
  );
  const core = coreCandidates.filter((item) => !factHits.some((hit) => String(hit.id) === String(item.id)));

  return {
    hits: factHits,
    journalHits,
    taskHits,
    groupHits,
    styleHits,
    jargonHits,
    core
  };
}

function buildRetrievedMemoryText(hits = [], core = [], factText = '', options = {}) {
  const relevantHits = Array.isArray(hits) ? hits : [];
  const coreHits = options.disableLegacyFactFallback ? [] : (Array.isArray(core) ? core : []);
  if (relevantHits.length > 0 || coreHits.length > 0) {
    const mainText = relevantHits.length > 0
      ? formatRetrievedMemories(relevantHits, {
        showScore: options.showMemoryScores === true,
        showReason: options.showMemoryReasons === true,
        showImportance: true,
        showStatus: false
      })
      : '';
    const coreText = coreHits.length > 0
      ? formatRetrievedMemories(coreHits, {
        showScore: false,
        showReason: false,
        showImportance: true,
        showStatus: false
      })
      : '';
    return [mainText, coreText].filter(Boolean).join('\n');
  }
  if (options.disableLegacyFactFallback) return '暂无与当前问题强相关的长期记忆';
  const compactFacts = compactFactText(factText, Math.max(1, Number(options.fallbackFactLines || 8)));
  return compactFacts && compactFacts !== '目前没有特别记忆。'
    ? `[NoStrongMatch]\n${compactFacts}`
    : '暂无与当前问题强相关的长期记忆';
}

function pickStyleSignals(styleHits = [], jargonHits = [], question = '', options = {}) {
  const queryIsStyleRelated = isStyleQuery(question, options);
  // Group jargon is not a generic fallback. Only explicit style/group-voice requests may inject it.
  const currentGroupId = sanitizeText(options.groupId);
  const allowJargonSignal = queryIsStyleRelated && Boolean(currentGroupId);
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(options.userId, options);
  const freshStyleHits = (Array.isArray(styleHits) ? styleHits : []).filter((hit) => !wasSignalRecentlyInjected(hit, options));
  const freshJargonHits = (Array.isArray(jargonHits) ? jargonHits : [])
    .filter((hit) => sanitizeText(hit?.groupId) === currentGroupId)
    .filter((hit) => !wasSignalRecentlyInjected(hit, options));

  const fallbackStyleHit = (!freshStyleHits.length && options.userId)
    ? memoizeValue(
      options,
      buildMemoKey('style-fallback', options.userId, 'style tone phrasing concise direct', {
        ...options,
        includeTask: false,
        includeGroup: false,
        includeEpisodes: false,
        memoryKind: 'style'
      }),
      () => retrieveUnifiedMemories(options.userId, 'style tone phrasing concise direct', 3, {
        ...buildUnifiedRecallOptions(options),
        includeTask: false,
        includeGroup: false,
        includeEpisodes: false,
        source: 'style',
        memoryKind: 'style',
        forceSignalRecall: true
      }).find((hit) => !wasSignalRecentlyInjected(hit, options))
    )
    : null;

  const fallbackJargonHit = (allowJargonSignal && !freshJargonHits.length && options.userId && resolvedGroupIds.length > 0)
    ? memoizeValue(
      options,
      buildMemoKey('jargon-fallback', options.userId, 'group jargon shorthand nickname term', {
        ...options,
        resolvedGroupIds,
        includeTask: false,
        includeGroup: true,
        includeEpisodes: false,
        memoryKind: 'jargon'
      }),
      () => retrieveUnifiedMemories(options.userId, 'group jargon shorthand nickname term', 3, {
        ...buildUnifiedRecallOptions(options),
        includeTask: false,
        includeGroup: true,
        includeEpisodes: false,
        source: 'jargon',
        memoryKind: 'jargon',
        forceSignalRecall: true
      }).find((hit) => sanitizeText(hit?.groupId) === currentGroupId && !wasSignalRecentlyInjected(hit, options))
    )
    : null;

  const preferredStyleHits = freshStyleHits.length ? freshStyleHits : (fallbackStyleHit ? [fallbackStyleHit] : []);
  const preferredJargonHits = allowJargonSignal
    ? (freshJargonHits.length ? freshJargonHits : (fallbackJargonHit ? [fallbackJargonHit] : []))
    : [];
  const selected = [];

  if (preferredStyleHits[0]) selected.push({ kind: 'style', hit: preferredStyleHits[0] });
  if (allowJargonSignal && !selected.length && preferredJargonHits[0]) {
    selected.push({ kind: 'jargon', hit: preferredJargonHits[0] });
  } else if (allowJargonSignal && selected.length === 1 && selected[0].kind === 'style' && preferredJargonHits[0]) {
    selected.push({ kind: 'jargon', hit: preferredJargonHits[0] });
  }

  const chosenHits = selected.map((item) => item.hit);
  markSignalsInjected(chosenHits, options);

  return {
    selectedHits: chosenHits,
    text: selected
      .map((item) => (item.kind === 'style' ? formatStyleSignal(item.hit) : formatJargonSignal(item.hit)))
      .filter(Boolean)
      .slice(0, 2)
      .join('\n')
  };
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
  return {
    enabled: true,
    strictPromptInjection: Boolean(config.MEMORY_STRICT_PROMPT_INJECTION_ENABLED),
    groupId: sanitizeText(options.groupId),
    routePolicyKey: sanitizeText(options.routePolicyKey),
    topRouteType: sanitizeText(options.topRouteType),
    hits: (Array.isArray(hits) ? hits : []).map((hit) => ({
      id: String(hit.id || ''),
      type: String(hit.type || hit.memoryKind || ''),
      source: String(hit.source || hit.sourceKind || hit.meta?.sourceKind || ''),
      status: String(hit.status || ''),
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
function buildContextPayload(userId, question = '', options = {}, unifiedHits = []) {
  const recapQuery = isRecentRecallQuery(question);
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(userId, options);
  const profile = getUserProfile(userId);
  const summary = getUserSummary(userId);
  const impression = getUserImpression(userId);
  const stableProfile = buildStableProfileText(userId, {
    question,
    includeWeakForProfileQuery: true,
    disableStableProfile: options.disableStableProfile,
    forceStableProfile: options.forceStableProfile,
    legacyFallbackEnabled: options.legacyProfileFallbackEnabled
  });
  const profilePersona = stableProfile.persona && typeof stableProfile.persona === 'object'
    ? stableProfile.persona
    : {};
  const profileDisabled = stableProfile.disabled === true;
  const effectiveSummary = profileDisabled
    ? ''
    : sanitizeText(profilePersona.summary || (stableProfile.legacyFallbackUsed ? stableProfile.summary : ''));
  const effectiveImpression = profileDisabled
    ? ''
    : sanitizeText(profilePersona.impression || (stableProfile.legacyFallbackUsed ? stableProfile.impression : ''));
  const affinityState = getUserAffinityState(userId, options);
  const factText = getUserMemories(userId);
  const dailyJournalTimestamp = resolveDailyJournalTimestamp(question, options);
  const dailyJournalBundle = memoizeValue(
    options,
    buildMemoKey('journal-bundle', userId, question || '', {
      ...options,
      dailyJournalTimestamp,
      includeActiveRaw: options.includeActiveRaw || recapQuery
    }),
    () => getDailyJournalRetrievalBundle(userId, {
      lookbackDays: options.dailyLookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS,
      timestamp: dailyJournalTimestamp,
      yearMonth: options.dailyJournalYearMonth,
      maxFourDayFiles: options.dailyJournalMaxFourDayFiles,
      maxMonthlyFiles: options.dailyJournalMaxMonthlyFiles,
      sessionKey: options.sessionKey,
      question,
      topic: question,
      includeActiveRaw: options.includeActiveRaw || recapQuery,
      activeRawMaxEntries: options.activeRawMaxEntries || 8
    })
  );
  const ragEnabled = options.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const {
    hits,
    journalHits,
    taskHits,
    groupHits,
    styleHits,
    jargonHits,
    core
  } = splitUnifiedHits(unifiedHits, { ...options, userId, question });
  const currentGroupId = sanitizeText(options.groupId);
  const promptGroupIds = currentGroupId ? [currentGroupId] : [];
  const promptGroupHits = groupHits.filter((hit) => {
    const hitGroupId = sanitizeText(hit?.groupId);
    return promptGroupIds.length > 0 && promptGroupIds.includes(hitGroupId);
  });
  const strictPromptInjection = Boolean(config.MEMORY_STRICT_PROMPT_INJECTION_ENABLED);
  const maxPromptStrong = Math.max(1, Number(config.MEMORY_RECALL_MAX_PROMPT_STRONG || 6) || 6);
  const strongHits = hits.filter((hit) => classifyRecallHitForPrompt(hit) === 'strong').slice(0, maxPromptStrong);
  const promptSourceHits = strictPromptInjection ? strongHits : hits;
  const promptRetrievedHits = promptSourceHits.filter((hit) => {
    const scopeType = String(hit?.scopeType || '').trim().toLowerCase();
    if (scopeType !== 'group') return true;
    const hitGroupId = sanitizeText(hit?.groupId);
    return promptGroupIds.length > 0 && promptGroupIds.includes(hitGroupId);
  });
  const promptJournalItems = buildPromptJournalItems(dailyJournalBundle);
  const promptDailyJournalText = Array.isArray(promptJournalItems)
    ? promptJournalItems
      .map(formatDailyJournalPromptItem)
      .filter(Boolean)
      .join('\n\n')
    : '';
  const retrievedMemoryForPrompt = ragEnabled
    ? buildRetrievedMemoryText(hits, core, factText, options)
    : factText;
  const promptRetrievedMemorySourceText = ragEnabled
    ? buildRetrievedMemoryText(promptRetrievedHits, core, factText, options)
    : factText;
  const taskMemoryText = formatTaskMemories(taskHits, { emptyText: '' });
  const groupMemoryText = formatGroupMemories(groupHits, { emptyText: '' });
  const promptGroupMemoryText = formatGroupMemories(promptGroupHits, { emptyText: '' });
  const styleSignal = pickStyleSignals(styleHits, jargonHits, question || '', {
    ...options,
    userId,
    resolvedGroupIds
  });
  const styleSignalText = styleSignal.text;
  const longTermProfileText = stableProfile.text || '';
  const promptLongTermProfileSourceText = stableProfile.text || '';
  const promptRetrievedMemoryText = limitPromptText(
    promptRetrievedMemorySourceText,
    getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420),
    'tail'
  );
  const promptStyleSignalsText = limitPromptText(
    styleSignalText,
    getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80),
    'tail'
  );
  const promptTaskMemoryText = limitPromptText(
    taskMemoryText,
    getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160),
    'tail'
  );
  const promptGroupMemoryTrimmedText = limitPromptText(
    promptGroupMemoryText,
    getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160),
    'tail'
  );
  const dailyJournalTokenLimit = dailyJournalTimestamp
    ? Math.max(
      getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160),
      getPromptTokenLimit('MAIN_PROMPT_TARGET_DAILY_JOURNAL_MAX_TOKENS', 420)
    )
    : getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160);
  const dailyJournalTrimStrategy = dailyJournalTimestamp ? 'head' : 'tail';
  const promptDailyJournalTrimmedText = limitPromptText(
    promptDailyJournalText,
    dailyJournalTokenLimit,
    dailyJournalTrimStrategy
  );
  const promptLongTermProfileText = limitPromptText(
    promptLongTermProfileSourceText,
    getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220),
    'tail'
  );
  const promptSummaryText = limitPromptText(
    effectiveSummary,
    getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
    'tail'
  );
  const promptImpressionText = limitPromptText(
    effectiveImpression,
    getPromptTokenLimit('MAIN_PROMPT_IMPRESSION_MAX_TOKENS', 96),
    'tail'
  );
  const memorySections = [];
  if (promptRetrievedMemoryText) memorySections.push(`[RetrievedMemory]\n${promptRetrievedMemoryText}`);
  if (promptStyleSignalsText) memorySections.push(`[StyleSignals]\n${promptStyleSignalsText}`);
  const segments = {
    retrievedMemory: clampPromptMessage('RetrievedMemory', promptRetrievedMemoryText, getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420), 'tail'),
    dailyJournal: clampPromptMessage('DailyJournal', promptDailyJournalTrimmedText, dailyJournalTokenLimit, dailyJournalTrimStrategy),
    taskMemory: clampPromptMessage('TaskMemory', promptTaskMemoryText, getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160), 'tail'),
    groupMemory: clampPromptMessage('GroupMemory', promptGroupMemoryTrimmedText, getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160), 'tail'),
    styleSignals: clampPromptMessage('StyleSignals', promptStyleSignalsText, getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80), 'tail'),
    longTermProfile: clampPromptMessage('LongTermProfile', promptLongTermProfileText, getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220), 'tail')
  };
  const memoryTrace = buildMemoryTrace({
    hits,
    injected: {
      retrievedMemory: promptRetrievedMemoryText,
      styleSignals: promptStyleSignalsText,
      taskMemory: promptTaskMemoryText,
      groupMemory: promptGroupMemoryTrimmedText,
      dailyJournal: promptDailyJournalTrimmedText,
      longTermProfile: promptLongTermProfileText
    },
    options: {
      ...options,
      memoryProfileTrace: {
        profile_source: stableProfile.source,
        profile_injected: Boolean(promptLongTermProfileText),
        traceItems: stableProfile.traceItems || [],
        conflicts: stableProfile.conflicts || [],
        suppressed: stableProfile.suppressed || [],
        expiresSoon: stableProfile.expiresSoon || [],
        legacyFallbackUsed: Boolean(stableProfile.legacyFallbackUsed),
        legacy_fallback_disabled: Boolean(options.disableLegacyFactFallback || recapQuery),
        profile_disabled_reason: stableProfile.reason || ''
      }
    }
  });

  return {
    memoryForPrompt: memorySections.filter(Boolean).join('\n\n') || promptRetrievedMemoryText,
    retrievedMemoryForPrompt,
    promptRetrievedMemoryText,
    hits,
    journalHits,
    taskHits,
    groupHits,
    promptGroupHits,
    styleHits,
    jargonHits,
    core,
    profile,
    stableProfile,
    persona: profilePersona,
    affinityState,
    profileText: stableProfile.text || '',
    impression: effectiveImpression,
    impressionText: effectiveImpression,
    summary: effectiveSummary,
    promptSummaryText,
    promptImpressionText,
    taskMemoryText,
    groupMemoryText,
    promptGroupMemoryText: promptGroupMemoryTrimmedText,
    styleSignalText,
    promptStyleSignalText: promptStyleSignalsText,
    longTermProfileText,
    promptLongTermProfileText,
    dailyJournalText: dailyJournalBundle.text || '',
    promptDailyJournalText: promptDailyJournalTrimmedText,
    dailyJournalItems: dailyJournalBundle.items || [],
    dailyJournalBundle,
    factText,
    stats: getMemoryStats(userId),
    diagnostics: memoryTrace ? { memoryTrace } : {},
    segments
  };
}

function buildMemoryContext(userId, question = '', options = {}) {
  const resolvedGroupIds = resolveReadableGroupIds(userId, options);
  const recapQuery = isRecentRecallQuery(question);
  const normalizedOptions = {
    ...options,
    userId,
    resolvedGroupIds,
    includeActiveRaw: options.includeActiveRaw || recapQuery,
    activeRawMaxEntries: options.activeRawMaxEntries || 8,
    disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery
  };
  const ragEnabled = options.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const unifiedHits = ragEnabled
    ? memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-sync', userId, question || '', normalizedOptions),
      () => retrieveUnifiedMemories(userId, question || '', options.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
        ...normalizedOptions,
        disableLegacyFactFallback: true,
        question
      }))
    )
    : [];
  return buildContextPayload(userId, question, normalizedOptions, unifiedHits);
}

async function buildMemoryContextAsync(userId, question = '', options = {}) {
  const recapQuery = isRecentRecallQuery(question);
  const baseOptions = {
    ...options,
    includeActiveRaw: options.includeActiveRaw || recapQuery,
    activeRawMaxEntries: options.activeRawMaxEntries || 8,
    disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery
  };
  const localKnowledge = await queryLocalKnowledge({
    userId,
    query: question || '',
    topK: baseOptions.topK || config.MEMORY_RAG_TOP_K || 8,
    groupId: baseOptions.groupId,
    groupIds: resolveReadableGroupIds(userId, baseOptions),
    sessionId: baseOptions.sessionId,
    sessionKey: baseOptions.sessionKey,
    routePolicyKey: baseOptions.routePolicyKey,
    topRouteType: baseOptions.topRouteType,
    taskType: baseOptions.taskType,
    agentName: baseOptions.agentName,
    toolName: baseOptions.toolName,
    lookbackDays: baseOptions.dailyLookbackDays || baseOptions.lookbackDays,
    skipMemoryV3: true
  });
  if (config.MEMORY_V3_ENABLED) {
    const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
    const queryResult = await queryMemory({
      userId,
      query: question || '',
      topK: baseOptions.topK || config.MEMORY_RAG_TOP_K || 8,
      groupId: baseOptions.groupId,
      groupIds: resolvedGroupIds,
      sessionId: baseOptions.sessionId,
      sessionKey: baseOptions.sessionKey,
      routePolicyKey: baseOptions.routePolicyKey,
      topRouteType: baseOptions.topRouteType,
      taskType: baseOptions.taskType,
      agentName: baseOptions.agentName,
      toolName: baseOptions.toolName,
      sharedShortTermSignature: baseOptions.sharedShortTermSignature
    });
    if (!Array.isArray(queryResult.results) || queryResult.results.length === 0) {
      const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
      const normalizedOptions = {
        ...baseOptions,
        userId,
        resolvedGroupIds
      };
      const unifiedHits = await memoizeValue(
        normalizedOptions,
        buildMemoKey('unified-async-v3-fallback', userId, question || '', normalizedOptions),
        () => retrieveUnifiedMemoriesAsync(userId, question || '', baseOptions.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
          ...normalizedOptions,
          disableLegacyFactFallback: true,
          question
        }))
      );
      return buildContextPayload(userId, question, normalizedOptions, unifiedHits);
    }
    const packet = assembleMemoryPacket(queryResult, {
      userId,
      sessionKey: baseOptions.sessionKey,
      question,
      disableStableProfile: baseOptions.disableStableProfile,
      forceStableProfile: baseOptions.forceStableProfile,
      legacyProfileFallbackEnabled: baseOptions.legacyProfileFallbackEnabled
    });
    const results = Array.isArray(queryResult.results) ? queryResult.results : [];
    const strictResults = Array.isArray(queryResult.strictResults) ? queryResult.strictResults : results;
    const weakResults = Array.isArray(queryResult.weakResults) ? queryResult.weakResults : [];
    const journalHits = results.filter((item) => item.source === 'journal');
    const taskHits = results.filter((item) => item.source === 'task');
    const groupHits = results.filter((item) => item.source === 'group');
    const styleHits = results.filter((item) => item.source === 'style');
    const jargonHits = results.filter((item) => item.source === 'jargon');
    const activeRawBundle = baseOptions.includeActiveRaw
      ? getDailyJournalRetrievalBundle(userId, {
        lookbackDays: baseOptions.dailyLookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS,
        timestamp: resolveDailyJournalTimestamp(question, baseOptions),
        yearMonth: baseOptions.dailyJournalYearMonth,
        maxFourDayFiles: baseOptions.dailyJournalMaxFourDayFiles,
        maxMonthlyFiles: baseOptions.dailyJournalMaxMonthlyFiles,
        sessionKey: baseOptions.sessionKey,
        question,
        topic: question,
        includeActiveRaw: true,
        activeRawMaxEntries: baseOptions.activeRawMaxEntries || 8
      })
      : null;
    const dailyJournalText = [
      activeRawBundle?.text,
      journalHits.map((item) => String(item.text || '')).filter(Boolean).join('\n')
    ].filter(Boolean).join('\n\n');
    const continuityFacet = String(queryResult.facet || '').trim().toLowerCase() === 'continuity';
    const retrievedPromptText = limitPromptText(
      packet.relevantEvidenceText || packet.sessionContinuityText || '',
      getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420),
      'tail'
    );
    const profileDisabled = packet.stableProfile?.disabled === true;
    const continuitySummaryText = continuityFacet
      ? limitPromptText(
          packet.sessionContinuityText || queryResult.digest || '',
          getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
          'tail'
        )
      : '';
    const summaryText = String(
      !profileDisabled && queryResult.persona?.summary
        ? queryResult.persona.summary
        : (continuityFacet
        ? limitPromptText(
            continuitySummaryText || packet.sessionContinuityText || queryResult.digest || '',
            getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
            'tail'
          )
        : (queryResult.digest || ''))
    );
    const impressionText = profileDisabled ? '' : String(queryResult.persona?.impression || '');
    const memoryForPrompt = [
      packet.sessionContinuityText ? `[SessionContinuity]\n${packet.sessionContinuityText}` : '',
      packet.relevantEvidenceText ? `[RelevantEvidence]\n${packet.relevantEvidenceText}` : '',
      (!continuityFacet || !packet.sessionContinuityText) && packet.weakEvidenceText ? `[WeakEvidence]\n${packet.weakEvidenceText}` : '',
      packet.styleSignalsText ? `[StyleSignals]\n${packet.styleSignalsText}` : ''
    ].filter(Boolean).join('\n\n');

    const notebookText = (localKnowledge.bySource?.notebook_doc || [])
      .map((item) => String(item.preview || item.text || '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('\n');
    return {
      memoryForPrompt,
      retrievedMemoryForPrompt: retrievedPromptText,
      promptRetrievedMemoryText: retrievedPromptText,
      hits: results,
      strictResults,
      weakResults,
      journalHits,
      taskHits,
      groupHits,
      promptGroupHits: groupHits,
      styleHits,
      jargonHits,
      core: [],
      profile: getUserProfile(userId),
      stableProfile: packet.stableProfile,
      persona: profileDisabled
        ? {}
        : (queryResult.persona && typeof queryResult.persona === 'object' ? queryResult.persona : {}),
      affinityState: queryResult.affinityState || getUserAffinityState(userId),
      profileText: packet.stableProfileText,
      impression: impressionText,
      impressionText,
      summary: summaryText,
      promptSummaryText: summaryText,
      promptImpressionText: impressionText,
      taskMemoryText: packet.taskStrategyText,
      groupMemoryText: [packet.groupSharedContextText, notebookText].filter(Boolean).join('\n'),
      promptGroupMemoryText: packet.groupSharedContextText,
      styleSignalText: packet.styleSignalsText,
      promptStyleSignalText: packet.styleSignalsText,
      longTermProfileText: packet.stableProfileText,
      promptLongTermProfileText: packet.stableProfileText,
      dailyJournalText,
      promptDailyJournalText: dailyJournalText,
      dailyJournalItems: activeRawBundle?.items?.length ? activeRawBundle.items : journalHits,
      dailyJournalBundle: activeRawBundle || { text: dailyJournalText, items: journalHits, byLayer: { daily: journalHits, fourDay: [], monthly: [] } },
      factText: getUserMemories(userId),
      stats: {
        total: Number(queryResult?.stats?.selected || 0),
        byType: {},
        byTier: {},
        byMemoryKind: {},
        byStatus: {},
        bySourceKind: {},
        localKnowledge: localKnowledge.diagnostics
      },
      diagnostics: {
        memoryTrace: buildMemoryTrace({
          hits: results,
          injected: {
            retrievedMemory: retrievedPromptText,
            weakEvidence: packet.weakEvidenceText,
            styleSignals: packet.styleSignalsText,
            taskMemory: packet.taskStrategyText,
            groupMemory: packet.groupSharedContextText,
            dailyJournal: dailyJournalText,
            longTermProfile: packet.stableProfileText
          },
          options: {
            ...options,
            memoryProfileTrace: {
              profile_source: packet.stableProfileSource,
              profile_injected: Boolean(packet.stableProfileText),
              traceItems: packet.stableProfile?.traceItems || [],
              conflicts: packet.stableProfile?.conflicts || [],
              suppressed: packet.stableProfile?.suppressed || [],
              expiresSoon: packet.stableProfile?.expiresSoon || [],
              legacyFallbackUsed: Boolean(packet.stableProfile?.legacyFallbackUsed),
              legacy_fallback_disabled: Boolean(baseOptions.disableLegacyFactFallback || recapQuery),
              profile_disabled_reason: packet.stableProfile?.reason || ''
            }
          }
        })
      },
      segments: {
        retrievedMemory: packet.messages.relevantEvidence?.length > 0
          ? packet.messages.relevantEvidence
          : (packet.messages.sessionContinuity || []),
        weakEvidence: packet.messages.weakEvidence || [],
        dailyJournal: [],
        taskMemory: packet.messages.taskStrategy || [],
        groupMemory: packet.messages.groupSharedContext || [],
        styleSignals: packet.messages.styleSignals || [],
        longTermProfile: packet.messages.stableProfile || [],
        sessionContinuity: packet.messages.sessionContinuity || []
      }
    };
  }
  const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
  const normalizedOptions = {
    ...baseOptions,
    userId,
    resolvedGroupIds
  };
  const ragEnabled = baseOptions.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const unifiedHits = ragEnabled
    ? await memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-async', userId, question || '', normalizedOptions),
      () => retrieveUnifiedMemoriesAsync(userId, question || '', baseOptions.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
        ...normalizedOptions,
        disableLegacyFactFallback: true,
        question
      }))
    )
    : [];
  return buildContextPayload(userId, question, normalizedOptions, unifiedHits);
}

module.exports = {
  buildMemoryContext,
  buildMemoryContextAsync,
  formatProfile,
  formatImpression,
  formatRetrievedMemories,
  resolveReadableGroupIds
};
