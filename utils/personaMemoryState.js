const fs = require('fs');
const path = require('path');
const config = require('../config');
const { estimateTokens, trimTextByTokenBudget } = require('./contextBudget');
const { getStyleProfile } = require('./styleProfileRuntime');
const { getGroupSocialContext } = require('./socialContextRuntime');
const {
  resolveShortTermSessionKey,
  normalizeShortTermState,
  buildSharedShortTermContextMessages
} = require('./shortTermMemory');
const { loadBridgeStore } = require('./shortTermBridgeMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { buildMemoryContextAsync, buildMemoryContext } = require('./memoryContext');
const { getUserAffinityState, getUserProfile } = require('./memory');
const {
  restoreSessionState,
  appendMemoryEvent,
  materializeMemoryViews
} = require('./memory-v3');
const { sanitizeUntrustedContent, shouldBlockMemoryLearning } = require('./promptSecurity');

const STATE_VERSION = 1;
const DEFAULT_SURFACE = 'direct_chat';

const CONTINUITY_PRIORITY = Object.freeze({
  session_projection: 500,
  short_term_bridge: 400,
  short_term_state: 360,
  same_session_summary: 300,
  same_session_journal: 260,
  task_memory: 180,
  group_memory: 160,
  generic_recall: 120,
  fallback: 0
});

const SURFACE_POLICIES = Object.freeze({
  direct_chat: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: true,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 5
  },
  passive_group_reply: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'group_only',
    maxMemoryDigestItems: 3
  },
  proactive_touch: {
    includeContinuity: true,
    includeRelationship: true,
    includeRecentReplyFrame: true,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  qzone_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  bot_diary: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 3
  },
  daily_share: {
    includeContinuity: true,
    includeRelationship: false,
    includeRecentReplyFrame: false,
    includeDeepHistory: false,
    allowJargon: 'off',
    maxMemoryDigestItems: 2
  }
});

function normalizeText(value, maxChars = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, Number(maxChars) || 1));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function uniqueStrings(values = [], limit = 6, maxChars = 180) {
  const out = [];
  const seen = new Set();
  for (const raw of normalizeArray(values)) {
    const text = normalizeText(raw, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function uniqueBy(items = [], selector = (item) => item) {
  const out = [];
  const seen = new Set();
  for (const item of normalizeArray(items)) {
    const key = normalizeText(selector(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clampMessageText(text = '', tokenBudget = 0, fallbackChars = 220) {
  const value = normalizeText(text);
  if (!value) return '';
  if (tokenBudget > 0) return trimTextByTokenBudget(value, tokenBudget, 'tail');
  return normalizeText(value, fallbackChars);
}

function getSurfacePolicy(surface = '') {
  const key = normalizeText(surface).toLowerCase() || DEFAULT_SURFACE;
  return SURFACE_POLICIES[key] || SURFACE_POLICIES[DEFAULT_SURFACE];
}

function readPromptManifest() {
  try {
    if (!fs.existsSync(config.PROMPT_MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(config.PROMPT_MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeReadText(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function loadPersonaCoreText() {
  const manifest = readPromptManifest();
  const sections = Array.isArray(manifest?.system_prompt?.sections)
    ? manifest.system_prompt.sections
    : [];
  const selected = sections.filter((section) => [
    'persona_core',
    'persona_style',
    'persona_policy',
    'persona_behavior',
    'persona_modulation'
  ].includes(String(section?.kind || '').trim()));
  const parts = selected
    .map((section) => safeReadText(path.join(config.PROMPTS_DIR, String(section.path || '').trim())))
    .map((text) => String(text || '').trim())
    .filter(Boolean);
  return parts.join('\n\n').trim() || String(config.SYSTEM_PROMPT || '').trim();
}

function normalizeEvidenceItem(item = {}, fallbackSource = 'fallback') {
  const source = normalizeText(item.source || fallbackSource).toLowerCase() || fallbackSource;
  const text = normalizeText(item.text || item.summary || item.content, 260);
  if (!text) return null;
  return {
    source,
    label: normalizeText(item.label || item.type || item.fieldKey || source, 48),
    text,
    confidence: Math.max(0, Math.min(1, Number(item.confidence || 0) || 0)),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : (CONTINUITY_PRIORITY[source] || 0),
    scope: normalizeText(item.scope || item.scopeType || '', 32),
    metadata: normalizeObject(item.metadata)
  };
}

function chooseBestScalar(entries = []) {
  const ordered = normalizeArray(entries)
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const p = Number(b.priority || 0) - Number(a.priority || 0);
      if (p !== 0) return p;
      const c = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (c !== 0) return c;
      return normalizeText(b.text).length - normalizeText(a.text).length;
    });
  return ordered[0] || null;
}

function mergeListCandidates(entries = [], limit = 4) {
  const ordered = normalizeArray(entries)
    .filter(Boolean)
    .slice()
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  return uniqueStrings(ordered.map((item) => item.text), limit, 180);
}

function buildCandidate(source, text, extras = {}) {
  return normalizeEvidenceItem({
    source,
    text,
    ...extras
  }, source);
}

function createRecentReplyFrameFromMessages(messages = []) {
  const turns = normalizeArray(messages)
    .map((item) => ({
      role: normalizeText(item?.role || '', 16).toLowerCase(),
      content: normalizeText(item?.content || item?.text || '', 240)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-4);
  if (!turns.length) return null;
  return {
    summary: turns.map((item) => `${item.role === 'assistant' ? 'A' : 'U'}:${item.content}`).join(' | '),
    turns
  };
}

function inferWarmth(relationship = '', attitude = '', surface = '') {
  const relationshipText = normalizeText(relationship).toLowerCase();
  const attitudeText = normalizeText(attitude).toLowerCase();
  if (['bot_diary', 'qzone_diary', 'daily_share'].includes(normalizeText(surface).toLowerCase())) return 'mid';
  if (/亲密|伙伴|信任|普通朋友/i.test(relationshipText) || /亲近|友好|积极|信任/i.test(attitudeText)) return 'high';
  if (/警惕|疏离|中立/i.test(relationshipText) || /距离|克制|边界/i.test(attitudeText)) return 'low';
  return 'mid';
}

function inferGuardedness(surface = '', relationship = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (['qzone_diary', 'bot_diary', 'daily_share'].includes(normalizedSurface)) return 'guarded';
  if (/亲密|伙伴/i.test(normalizeText(relationship))) return 'soft_open';
  return 'guarded';
}

function inferPlayfulness(styleProfile = {}, socialContext = {}, surface = '') {
  const profile = normalizeObject(styleProfile.globalBotBase, {});
  const tags = normalizeArray(profile.toneTags).map((item) => normalizeText(item).toLowerCase());
  if (['qzone_diary', 'bot_diary'].includes(normalizeText(surface).toLowerCase())) return tags.includes('playful') ? 'high' : 'mid';
  if (tags.includes('playful') || tags.includes('cute')) return 'mid';
  if (normalizeText(socialContext.atmosphere).includes('活跃')) return 'mid';
  return 'low';
}

function inferVerbosity(surface = '', styleProfile = {}) {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'proactive_touch') return 'terse';
  if (normalizedSurface === 'qzone_diary' || normalizedSurface === 'bot_diary') return 'rich';
  const sentenceLength = normalizeText(styleProfile?.globalBotBase?.sentenceLength || '', 16).toLowerCase();
  if (sentenceLength === 'short') return 'terse';
  if (sentenceLength === 'long') return 'rich';
  return 'normal';
}

function inferTease(styleProfile = {}, socialContext = {}, surface = '') {
  if (['qzone_diary', 'bot_diary'].includes(normalizeText(surface).toLowerCase())) return 'light';
  const profile = normalizeObject(styleProfile.globalBotBase, {});
  if (Number(profile.teaseCueRatio || 0) >= 0.18) return 'light';
  if (normalizeArray(socialContext.topTeasePairs).length > 0) return 'light';
  return 'off';
}

function inferJargon(surface = '', groupId = '', styleSignals = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (!groupId) return 'off';
  if (normalizedSurface === 'passive_group_reply' || normalizedSurface === 'direct_chat') {
    return 'group_only';
  }
  return 'off';
}

function inferInitiative(surface = '') {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (normalizedSurface === 'passive_group_reply') return 'reply';
  if (normalizedSurface === 'proactive_touch') return 'proactive';
  return 'reply';
}

function buildExpressionState({ surface, relationshipState, styleProfile, socialContext, memoryContext }) {
  return {
    warmth: inferWarmth(relationshipState.relationship, relationshipState.attitude, surface),
    playfulness: inferPlayfulness(styleProfile, socialContext, surface),
    tease: inferTease(styleProfile, socialContext, surface),
    initiative: inferInitiative(surface),
    jargon: inferJargon(surface, relationshipState.groupId, memoryContext?.styleSignalText),
    verbosity: inferVerbosity(surface, styleProfile),
    guardedness: inferGuardedness(surface, relationshipState.relationship)
  };
}

function buildRelationshipState({ userId, groupId, memoryContext, affinityState, profile }) {
  const relation = normalizeText(
    profile?.relation_stage
    || memoryContext?.profile?.relation_stage
    || affinityState?.relationship
    || affinityState?.level
    || '陌生人',
    48
  ) || '陌生人';
  const attitude = normalizeText(
    affinityState?.attitude
    || memoryContext?.impressionText
    || '中立、保持距离',
    160
  ) || '中立、保持距离';
  return {
    userId: normalizeText(userId),
    groupId: normalizeText(groupId),
    relationship: relation,
    attitude,
    replyStylePolicy: normalizeText(memoryContext?.affinityState?.replyStylePolicy || '', 200),
    salutationPolicy: relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved')
  };
}

function buildMemoryDigest(memoryContext = {}, options = {}) {
  const surfacePolicy = getSurfacePolicy(options.surface);
  const items = [];
  const push = (source, label, text, confidence = 0.5) => {
    const normalized = normalizeEvidenceItem({ source, label, text, confidence }, source);
    if (normalized) items.push(normalized);
  };

  push('generic_recall', 'retrieved', memoryContext.promptRetrievedMemoryText || memoryContext.retrievedMemoryForPrompt, 0.72);
  push('task_memory', 'task', memoryContext.taskMemoryText, 0.66);
  push('group_memory', 'group', memoryContext.groupMemoryText, 0.62);
  push('generic_recall', 'profile', memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText, 0.7);
  push('same_session_journal', 'journal', memoryContext.promptDailyJournalText || memoryContext.dailyJournalText, 0.58);

  const selected = uniqueBy(items, (item) => `${item.source}:${item.text}`)
    .slice(0, Math.max(1, Number(surfacePolicy.maxMemoryDigestItems) || 1));

  return {
    items: selected,
    text: selected.map((item) => `[${item.source}] ${item.text}`).join('\n'),
    bySource: selected.reduce((acc, item) => {
      acc[item.source] = acc[item.source] || [];
      acc[item.source].push(item.text);
      return acc;
    }, {})
  };
}

function buildPromptBlock(label, text, tokenBudget) {
  const value = clampMessageText(text, tokenBudget, 480);
  if (!value) return null;
  return {
    label,
    text: value,
    message: { role: 'system', content: `[${label}]\n${value}` }
  };
}

function sanitizePromptBlocks(blocks = [], totalBudget = 2400) {
  const selected = normalizeArray(blocks).filter(Boolean);
  const messages = [];
  let used = 0;
  for (const block of selected) {
    const msg = block?.message;
    if (!msg) continue;
    const cost = estimateTokens(String(msg.content || ''));
    if (used > 0 && used + cost > totalBudget && block.label !== 'PersonaCore' && block.label !== 'SurfacePolicy') {
      continue;
    }
    messages.push(msg);
    used += cost;
  }
  return messages;
}

function formatRelationshipStateText(state = {}) {
  const lines = [];
  if (state.relationship) lines.push(`relationship=${state.relationship}`);
  if (state.attitude) lines.push(`attitude=${state.attitude}`);
  if (state.replyStylePolicy) lines.push(`reply_style_policy=${state.replyStylePolicy}`);
  if (state.salutationPolicy) lines.push(`salutation=${state.salutationPolicy}`);
  return lines.join('\n');
}

function formatContinuityStateText(state = {}, options = {}) {
  const lines = [];
  if (state.activeTopic) lines.push(`active_topic=${state.activeTopic}`);
  if (state.carryOverUserTurn) lines.push(`carry_over_user_turn=${state.carryOverUserTurn}`);
  if (normalizeArray(state.openLoops).length) lines.push(`open_loops=${state.openLoops.join(' | ')}`);
  if (normalizeArray(state.assistantCommitments).length) lines.push(`assistant_commitments=${state.assistantCommitments.join(' | ')}`);
  if (normalizeArray(state.userConstraints).length) lines.push(`user_constraints=${state.userConstraints.join(' | ')}`);
  if (state.recentReplyFrame && options.includeRecentReplyFrame !== false) lines.push(`recent_reply_frame=${state.recentReplyFrame}`);
  if (state.summary) lines.push(`summary=${state.summary}`);
  if (normalizeObject(state.sources) && Object.keys(state.sources).length > 0) {
    const sourceLines = [];
    if (state.sources.activeTopic) sourceLines.push(`active_topic:${state.sources.activeTopic}`);
    if (state.sources.carryOverUserTurn) sourceLines.push(`carry_over:${state.sources.carryOverUserTurn}`);
    if (state.sources.summary) sourceLines.push(`summary:${state.sources.summary}`);
    if (sourceLines.length) lines.push(`sources=${sourceLines.join(', ')}`);
  }
  return lines.join('\n');
}

function formatExpressionStateText(state = {}) {
  return [
    `warmth=${state.warmth || 'mid'}`,
    `playfulness=${state.playfulness || 'low'}`,
    `tease=${state.tease || 'off'}`,
    `initiative=${state.initiative || 'reply'}`,
    `jargon=${state.jargon || 'off'}`,
    `verbosity=${state.verbosity || 'normal'}`,
    `guardedness=${state.guardedness || 'guarded'}`
  ].join('\n');
}

function formatMemoryDigestText(digest = {}) {
  return normalizeArray(digest.items)
    .map((item) => `[${item.source}${item.label ? `|${item.label}` : ''}] ${item.text}`)
    .join('\n');
}

function formatSurfacePolicyText(surface = '', policy = {}) {
  return [
    `surface=${surface || DEFAULT_SURFACE}`,
    `include_continuity=${policy.includeContinuity !== false}`,
    `include_relationship=${policy.includeRelationship !== false}`,
    `include_recent_reply_frame=${policy.includeRecentReplyFrame !== false}`,
    `include_deep_history=${policy.includeDeepHistory !== false}`,
    `allow_jargon=${policy.allowJargon || 'off'}`,
    `max_memory_digest_items=${Number(policy.maxMemoryDigestItems || 0) || 0}`
  ].join('\n');
}

function resolveContinuitySlots(candidates = {}, policy = {}) {
  const normalized = normalizeObject(candidates);
  const activeTopic = chooseBestScalar(normalized.activeTopic);
  const carryOver = chooseBestScalar(normalized.carryOver);
  const summary = chooseBestScalar(normalized.summary);
  const recentReplyFrame = chooseBestScalar(normalized.recentReplyFrame);
  const openLoops = mergeListCandidates(normalized.openLoops, 4);
  const assistantCommitments = mergeListCandidates(normalized.assistantCommitments, 4);
  const userConstraints = mergeListCandidates(normalized.userConstraints, 4);

  return {
    activeTopic: activeTopic?.text || '',
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOverUserTurn: carryOver?.text || '',
    summary: summary?.text || '',
    recentReplyFrame: recentReplyFrame?.text || '',
    sources: {
      activeTopic: activeTopic?.source || '',
      carryOverUserTurn: carryOver?.source || '',
      summary: summary?.source || '',
      openLoops: normalizeArray(normalized.openLoops).map((item) => item?.source).filter(Boolean),
      assistantCommitments: normalizeArray(normalized.assistantCommitments).map((item) => item?.source).filter(Boolean),
      userConstraints: normalizeArray(normalized.userConstraints).map((item) => item?.source).filter(Boolean),
      recentReplyFrame: recentReplyFrame?.source || ''
    },
    conflicts: {
      activeTopic: normalizeArray(normalized.activeTopic).length > 1,
      carryOverUserTurn: normalizeArray(normalized.carryOver).length > 1,
      summary: normalizeArray(normalized.summary).length > 1
    },
    policy: normalizeObject(policy)
  };
}

async function readSessionProjectionState(userId = '', sessionKey = '', request = {}) {
  if (!config.MEMORY_V3_ENABLED) return { restored: false, mode: 'none', session: null };
  return restoreSessionState(sessionKey, {
    userId,
    groupId: request.groupId || request.routeMeta?.groupId || request.routeMeta?.group_id || '',
    query: request.question || ''
  });
}

function buildContinuityCandidates({
  sessionProjection = {},
  shortTermState = {},
  shortTermRecentMessages = [],
  bridgeState = {},
  bridgeRecentMessages = [],
  sessionSummaries = [],
  journalBundle = {},
  memoryContext = {}
}) {
  const activeTopic = [];
  const openLoops = [];
  const assistantCommitments = [];
  const userConstraints = [];
  const carryOver = [];
  const summary = [];
  const recentReplyFrame = [];

  const pushScalar = (bucket, source, value, extras = {}) => {
    const candidate = buildCandidate(source, value, extras);
    if (candidate) bucket.push(candidate);
  };
  const pushList = (bucket, source, values, extras = {}) => {
    for (const value of normalizeArray(values)) {
      const candidate = buildCandidate(source, value, extras);
      if (candidate) bucket.push(candidate);
    }
  };

  const projection = normalizeObject(sessionProjection.session);
  pushScalar(activeTopic, 'session_projection', projection.activeTopic, { confidence: 0.98 });
  pushScalar(carryOver, 'session_projection', projection.carryOverUserTurn, { confidence: 0.98 });
  pushScalar(summary, 'session_projection', projection.summary, { confidence: 0.96 });
  pushList(openLoops, 'session_projection', projection.openLoops, { confidence: 0.96 });
  pushList(assistantCommitments, 'session_projection', projection.assistantCommitments, { confidence: 0.96 });
  pushList(userConstraints, 'session_projection', projection.userConstraints, { confidence: 0.94 });
  if (normalizeArray(projection.recentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'session_projection', createRecentReplyFrameFromMessages(projection.recentMessages)?.summary, { confidence: 0.94 });
  }

  const normalizedBridgeState = normalizeShortTermState(bridgeState);
  pushScalar(activeTopic, 'short_term_bridge', normalizedBridgeState.activeTopic, { confidence: 0.88 });
  pushScalar(carryOver, 'short_term_bridge', normalizedBridgeState.carryOverUserTurn, { confidence: 0.92 });
  pushScalar(summary, 'short_term_bridge', normalizedBridgeState.summary, { confidence: 0.84 });
  pushList(openLoops, 'short_term_bridge', normalizedBridgeState.openLoops, { confidence: 0.86 });
  pushList(assistantCommitments, 'short_term_bridge', normalizedBridgeState.assistantCommitments, { confidence: 0.86 });
  pushList(userConstraints, 'short_term_bridge', normalizedBridgeState.userConstraints, { confidence: 0.84 });
  if (normalizeArray(bridgeRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_bridge', createRecentReplyFrameFromMessages(bridgeRecentMessages)?.summary, { confidence: 0.84 });
  }

  const normalizedShortTerm = normalizeShortTermState(shortTermState);
  pushScalar(activeTopic, 'short_term_state', normalizedShortTerm.activeTopic, { confidence: 0.82 });
  pushScalar(carryOver, 'short_term_state', normalizedShortTerm.carryOverUserTurn, { confidence: 0.82 });
  pushScalar(summary, 'short_term_state', normalizedShortTerm.summary, { confidence: 0.78 });
  pushList(openLoops, 'short_term_state', normalizedShortTerm.openLoops, { confidence: 0.78 });
  pushList(assistantCommitments, 'short_term_state', normalizedShortTerm.assistantCommitments, { confidence: 0.78 });
  pushList(userConstraints, 'short_term_state', normalizedShortTerm.userConstraints, { confidence: 0.76 });
  if (normalizeArray(shortTermRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_state', createRecentReplyFrameFromMessages(shortTermRecentMessages)?.summary, { confidence: 0.76 });
  }

  const latestSessionSummary = normalizeArray(sessionSummaries)[0];
  pushScalar(summary, 'same_session_summary', latestSessionSummary?.summary, { confidence: 0.72 });

  const sameSessionJournal = normalizeArray(journalBundle?.continuity?.sameSession);
  const journalEntry = sameSessionJournal[0] || normalizeArray(journalBundle?.continuity?.sameTopic)[0];
  if (journalEntry?.continuitySnapshot) {
    const snapshot = normalizeObject(journalEntry.continuitySnapshot);
    pushScalar(activeTopic, 'same_session_journal', snapshot.activeTopic, { confidence: 0.68 });
    pushScalar(carryOver, 'same_session_journal', snapshot.carryOverUserTurn, { confidence: 0.68 });
    pushList(openLoops, 'same_session_journal', snapshot.openLoops, { confidence: 0.68 });
    pushList(assistantCommitments, 'same_session_journal', snapshot.assistantCommitments, { confidence: 0.66 });
    pushList(userConstraints, 'same_session_journal', snapshot.userConstraints, { confidence: 0.64 });
  }

  pushScalar(summary, 'generic_recall', memoryContext.promptSummaryText || memoryContext.summary, { confidence: 0.48 });
  pushScalar(activeTopic, 'task_memory', memoryContext.taskMemoryText, { confidence: 0.44 });
  pushScalar(activeTopic, 'group_memory', memoryContext.groupMemoryText, { confidence: 0.42 });

  return {
    activeTopic,
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOver,
    summary,
    recentReplyFrame
  };
}

async function composePersonaMemoryState(request = {}, options = {}) {
  const normalizedRequest = normalizeObject(request);
  const routeMeta = normalizeObject(normalizedRequest.routeMeta);
  const userId = normalizeText(normalizedRequest.userId || options.userId);
  const surface = normalizeText(options.surface || normalizedRequest.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const groupId = normalizeText(options.groupId || normalizedRequest.groupId || routeMeta.groupId || routeMeta.group_id);
  const sessionKey = normalizeText(
    options.sessionKey
    || normalizedRequest.sessionKey
    || routeMeta.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  const question = normalizeText(normalizedRequest.question || normalizedRequest.text || options.question, 1000);
  const shortTermStore = normalizeObject(options.shortTermMemory || options.shortTermStore);
  const chatHistory = normalizeObject(options.chatHistory || options.historyStore);
  const sharedShortTermContext = buildSharedShortTermContextMessages(userId, normalizeObject(options.userInfo), {
    chatHistory,
    shortTermMemory: shortTermStore,
    routeMeta,
    sessionKey
  });
  const shortTermState = normalizeShortTermState(sharedShortTermContext.shortTermState);
  const shortTermRecentMessages = normalizeArray(sharedShortTermContext.recentHistory);
  const bridgeStore = loadBridgeStore();
  const bridgeEntry = normalizeObject(bridgeStore.sessions?.[sessionKey]);
  const bridgeState = normalizeShortTermState(bridgeEntry.shortTermState);
  const bridgeRecentMessages = normalizeArray(bridgeEntry.recentMessages);
  const sessionProjection = await readSessionProjectionState(userId, sessionKey, {
    ...normalizedRequest,
    groupId
  });
  const sessionSummaries = getRecentSessionContextSummaries(sessionKey, { limit: 3 });
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    sessionKey,
    question,
    topic: shortTermState.activeTopic || bridgeState.activeTopic || question,
    lookbackDays: options.lookbackDays
  });
  const memoryContextBuilder = options.useSyncMemoryContext ? buildMemoryContext : buildMemoryContextAsync;
  const memoryContext = await memoryContextBuilder(userId, question, {
    routePolicyKey: normalizeText(normalizedRequest.routePolicyKey || options.routePolicyKey),
    topRouteType: normalizeText(normalizedRequest.topRouteType || options.topRouteType),
    groupId,
    sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || normalizedRequest.sessionId),
    sessionKey,
    channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id || normalizedRequest.channelId),
    taskType: normalizeText(routeMeta.taskType || routeMeta.task_type || normalizedRequest.taskType),
    agentName: normalizeText(routeMeta.agentName || routeMeta.agent_name),
    toolName: normalizeText(routeMeta.toolName || routeMeta.tool_name),
    sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
  });
  const styleProfile = getStyleProfile(groupId);
  const socialContext = groupId ? getGroupSocialContext(groupId) : {};
  const affinityState = normalizeObject(memoryContext.affinityState) && Object.keys(normalizeObject(memoryContext.affinityState)).length
    ? memoryContext.affinityState
    : getUserAffinityState(userId);
  const profile = getUserProfile(userId) || {};
  const relationshipState = buildRelationshipState({
    userId,
    groupId,
    memoryContext,
    affinityState,
    profile
  });
  const continuityCandidates = buildContinuityCandidates({
    sessionProjection,
    shortTermState,
    shortTermRecentMessages,
    bridgeState,
    bridgeRecentMessages,
    sessionSummaries,
    journalBundle,
    memoryContext
  });
  const continuityState = resolveContinuitySlots(continuityCandidates, getSurfacePolicy(surface));
  const recentReplyFrame = createRecentReplyFrameFromMessages(
    normalizeArray(sessionProjection.session?.recentMessages).length
      ? sessionProjection.session.recentMessages
      : (normalizeArray(bridgeRecentMessages).length ? bridgeRecentMessages : shortTermRecentMessages)
  );
  if (recentReplyFrame?.summary && !continuityState.recentReplyFrame) {
    continuityState.recentReplyFrame = recentReplyFrame.summary;
    continuityState.sources.recentReplyFrame = continuityState.sources.recentReplyFrame || 'recent_messages';
  }
  const expressionState = buildExpressionState({
    surface,
    relationshipState,
    styleProfile,
    socialContext,
    memoryContext
  });
  const memoryDigest = buildMemoryDigest(memoryContext, { surface });
  const personaCore = {
    text: loadPersonaCoreText(),
    source: 'static_persona_manifest'
  };
  const evidence = {
    continuityCandidates,
    sessionProjection: normalizeObject(sessionProjection.session),
    shortTermBridge: bridgeEntry,
    shortTermState,
    sessionSummaries,
    journal: normalizeObject(journalBundle.continuity),
    memoryContext: {
      promptRetrievedMemoryText: memoryContext.promptRetrievedMemoryText || '',
      styleSignalText: memoryContext.styleSignalText || '',
      taskMemoryText: memoryContext.taskMemoryText || '',
      groupMemoryText: memoryContext.groupMemoryText || '',
      dailyJournalText: memoryContext.promptDailyJournalText || memoryContext.dailyJournalText || ''
    },
    styleProfile,
    socialContext,
    affinityState
  };

  return {
    version: STATE_VERSION,
    surface,
    sessionKey,
    userId,
    groupId,
    personaCore,
    relationshipState,
    continuityState,
    expressionState,
    memoryDigest,
    evidence
  };
}

function renderPersonaMemoryPrompt(state = {}, surface = '') {
  const normalizedState = normalizeObject(state);
  const surfaceName = normalizeText(surface || normalizedState.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const surfacePolicy = getSurfacePolicy(surfaceName);
  const promptBudget = Math.max(1000, Number(config.MAIN_PROMPT_PERSONA_MEMORY_MAX_TOKENS || 2200) || 2200);
  const promptBlocks = [
    buildPromptBlock('PersonaCore', normalizedState.personaCore?.text, Math.min(promptBudget * 0.3, 900)),
    surfacePolicy.includeRelationship !== false
      ? buildPromptBlock('RelationshipState', formatRelationshipStateText(normalizedState.relationshipState), 220)
      : null,
    surfacePolicy.includeContinuity !== false
      ? buildPromptBlock('ContinuityState', formatContinuityStateText(normalizedState.continuityState, {
          includeRecentReplyFrame: surfacePolicy.includeRecentReplyFrame !== false
        }), 360)
      : null,
    buildPromptBlock('ExpressionPolicy', formatExpressionStateText(normalizedState.expressionState), 140),
    buildPromptBlock('RelevantMemoryDigest', formatMemoryDigestText(normalizedState.memoryDigest), 360),
    buildPromptBlock('SurfacePolicy', formatSurfacePolicyText(surfaceName, surfacePolicy), 140)
  ].filter(Boolean);

  return {
    systemMessages: sanitizePromptBlocks(promptBlocks, promptBudget),
    promptBlocks,
    policy: surfacePolicy
  };
}

function deriveSessionCheckpointPayload(state = {}, payload = {}) {
  const continuity = normalizeObject(state.continuityState);
  const recentReplyFrame = normalizeText(payload.recentReplyFrame || continuity.recentReplyFrame, 320);
  const recentMessages = normalizeArray(payload.recentMessages)
    .map((item) => ({
      role: normalizeText(item?.role || '', 16).toLowerCase(),
      content: normalizeText(item?.content || item?.text || '', 320)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)));

  if (!recentMessages.length && recentReplyFrame) {
    recentMessages.push({ role: 'assistant', content: recentReplyFrame });
  }

  return {
    snapshotType: normalizeText(payload.snapshotType || 'post_reply'),
    activeTopic: normalizeText(payload.activeTopic || continuity.activeTopic, 180),
    carryOverUserTurn: normalizeText(payload.carryOverUserTurn || continuity.carryOverUserTurn, 220),
    summary: normalizeText(payload.summary || continuity.summary, 2400),
    openLoops: uniqueStrings(payload.openLoops || continuity.openLoops, 4, 120),
    assistantCommitments: uniqueStrings(payload.assistantCommitments || continuity.assistantCommitments, 4, 120),
    userConstraints: uniqueStrings(payload.userConstraints || continuity.userConstraints, 4, 120),
    recentMessages
  };
}

async function recordPersonaMemoryOutcome(surface = '', payload = {}) {
  const normalizedPayload = normalizeObject(payload);
  const state = normalizeObject(normalizedPayload.state);
  const request = normalizeObject(normalizedPayload.request);
  const routeMeta = normalizeObject(request.routeMeta || normalizedPayload.routeMeta);
  const userId = normalizeText(normalizedPayload.userId || request.userId || state.userId);
  const sessionKey = normalizeText(
    normalizedPayload.sessionKey
    || request.sessionKey
    || state.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  if (!config.MEMORY_V3_ENABLED || !userId || !sessionKey) {
    return { updatedSlots: {}, persisted: false };
  }

  const continuity = normalizeObject(state.continuityState);
  const expression = normalizeObject(state.expressionState);
  const groupId = normalizeText(normalizedPayload.groupId || request.groupId || routeMeta.groupId || routeMeta.group_id || state.groupId);
  const channelId = normalizeText(routeMeta.channelId || routeMeta.channel_id || request.channelId);
  const sessionId = normalizeText(routeMeta.sessionId || routeMeta.session_id || request.sessionId);
  const routePolicyKey = normalizeText(request.routePolicyKey || normalizedPayload.routePolicyKey);
  const topRouteType = normalizeText(request.topRouteType || normalizedPayload.topRouteType);
  const expressionFingerprint = Object.entries(expression)
    .map(([key, value]) => `${key}=${normalizeText(value, 32)}`)
    .filter(Boolean)
    .join(', ');
  const expressionGate = shouldBlockMemoryLearning(expressionFingerprint, 'style_pattern', {
    routePolicyKey,
    topRouteType
  });
  const checkpointPayload = deriveSessionCheckpointPayload(state, normalizedPayload);

  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId,
    sessionKey,
    groupId,
    channelId,
    sessionId,
    routePolicyKey,
    topRouteType,
    scopeType: 'session',
    source: normalizeText(surface || state.surface || DEFAULT_SURFACE),
    sourceKind: 'runtime',
    payload: checkpointPayload
  });

  if (expressionFingerprint && !expressionGate.blocked) {
    await appendMemoryEvent({
      type: 'memory_confirmed',
      userId,
      sessionKey,
      groupId,
      channelId,
      sessionId,
      routePolicyKey,
      topRouteType,
      scopeType: groupId ? 'group' : 'personal',
      source: normalizeText(surface || state.surface || DEFAULT_SURFACE),
      sourceKind: 'runtime',
      status: 'active',
      memoryKind: 'style',
      semanticSlot: 'style_pattern',
      text: `style: ${sanitizeUntrustedContent(expressionFingerprint, 'memory')}`,
      payload: {
        fieldKey: 'style_pattern',
        type: 'fact'
      },
      confidence: 0.7,
      importance: 0.6,
      evidenceCount: 1
    });
  }

  materializeMemoryViews();
  return {
    updatedSlots: {
      activeTopic: checkpointPayload.activeTopic,
      openLoops: checkpointPayload.openLoops,
      assistantCommitments: checkpointPayload.assistantCommitments,
      userConstraints: checkpointPayload.userConstraints,
      carryOverUserTurn: checkpointPayload.carryOverUserTurn,
      recentReplyFrame: continuity.recentReplyFrame || ''
    },
    persisted: true
  };
}

module.exports = {
  CONTINUITY_PRIORITY,
  STATE_VERSION,
  composePersonaMemoryState,
  getSurfacePolicy,
  recordPersonaMemoryOutcome,
  renderPersonaMemoryPrompt,
  resolveContinuitySlots
};
