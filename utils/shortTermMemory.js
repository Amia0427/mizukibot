const config = require('../config');
const {
  normalizeMessageContent,
  estimateMessagesTokens,
  estimateTokens,
  getAffinitySettings,
  trimMessagesByTokenBudget,
  trimTextByTokenBudget
} = require('./contextBudget');
const { getUserMemories, getUserProfile, getUserSummary, getUserImpression } = require('./memory');
const { retrieveRelevantMemories } = require('./vectorMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');

function getShortTermCompressionSettings(userInfo = {}, options = {}) {
  const affinity = getAffinitySettings(userInfo, { userId: options.userId });
  const reserveRecentMessages = Math.max(
    2,
    Number(config.SHORT_TERM_MEMORY_RECENT_MESSAGES || config.MAX_HISTORY || 15)
  );
  const summaryMaxTokens = Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320));
  const triggerRatio = Math.min(
    0.98,
    Math.max(0.3, Number(config.SHORT_TERM_MEMORY_COMPRESSION_TRIGGER_RATIO || 0.7))
  );
  const maxCompressionRounds = Math.max(1, Number(config.SHORT_TERM_MEMORY_MAX_COMPRESSION_ROUNDS || 2));

  return {
    affinity,
    reserveRecentMessages,
    summaryMaxTokens,
    triggerTokens: Math.max(64, Math.floor(affinity.shortTermMemoryTokens * triggerRatio)),
    maxCompressionRounds
  };
}

function getStateMaxItems() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_STATE_MAX_ITEMS || 4)));
}

function getToolResultMaxItems() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_TOOL_RESULT_MAX_ITEMS || 3)));
}

function getCarryOverMaxChars() {
  return 220;
}

function trimShortText(value, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeStringList(values = [], limit = 4, itemMaxChars = 140) {
  const output = [];
  const seen = new Set();

  for (const raw of Array.isArray(values) ? values : []) {
    const text = trimShortText(raw, itemMaxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= Math.max(1, Number(limit) || 1)) break;
  }

  return output;
}

const SESSION_PRESENCE_STATES = new Set([
  'observing',
  'considering',
  'waiting',
  'interjecting',
  'cooling',
  'closed'
]);

const SESSION_PRESENCE_ACTIONS = new Set([
  'no_reply',
  'wait',
  'reply',
  'follow_up',
  'exit'
]);

function normalizeSessionPresenceState(value, fallback = 'observing') {
  const state = trimShortText(value, 24);
  return SESSION_PRESENCE_STATES.has(state) ? state : fallback;
}

function normalizeSessionPresenceAction(value, fallback = 'no_reply') {
  const action = trimShortText(value, 24);
  return SESSION_PRESENCE_ACTIONS.has(action) ? action : fallback;
}

function defaultShortTermPresence() {
  return {
    state: 'observing',
    lastAction: 'no_reply',
    stateUpdatedAt: 0,
    lastInboundAt: 0,
    lastHumanInboundAt: 0,
    lastAtBotInboundAt: 0,
    lastBotReplyAt: 0,
    humanTurnsSinceBotReply: 0,
    waitingSince: 0,
    closedAt: 0
  };
}

function normalizeShortTermPresence(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const fallback = defaultShortTermPresence();
  return {
    state: normalizeSessionPresenceState(raw.state, fallback.state),
    lastAction: normalizeSessionPresenceAction(raw.lastAction, fallback.lastAction),
    stateUpdatedAt: Number(raw.stateUpdatedAt || 0) || 0,
    lastInboundAt: Number(raw.lastInboundAt || 0) || 0,
    lastHumanInboundAt: Number(raw.lastHumanInboundAt || 0) || 0,
    lastAtBotInboundAt: Number(raw.lastAtBotInboundAt || 0) || 0,
    lastBotReplyAt: Number(raw.lastBotReplyAt || 0) || 0,
    humanTurnsSinceBotReply: Math.max(0, Number(raw.humanTurnsSinceBotReply || 0) || 0),
    waitingSince: Number(raw.waitingSince || 0) || 0,
    closedAt: Number(raw.closedAt || 0) || 0
  };
}

function defaultShortTermState() {
  return {
    summary: '',
    activeTopic: '',
    openLoops: [],
    assistantCommitments: [],
    userConstraints: [],
    recentToolResults: [],
    carryOverUserTurn: '',
    presence: defaultShortTermPresence(),
    lastCompressedAt: 0,
    rounds: 0
  };
}

function normalizeShortTermState(input = {}) {
  const old = input && typeof input === 'object' ? input : {};
  return {
    summary: trimShortText(old.summary, 2400),
    activeTopic: trimShortText(old.activeTopic, 180),
    openLoops: normalizeStringList(old.openLoops, getStateMaxItems(), 120),
    assistantCommitments: normalizeStringList(old.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: normalizeStringList(old.userConstraints, getStateMaxItems(), 120),
    recentToolResults: normalizeStringList(old.recentToolResults, getToolResultMaxItems(), 160),
    carryOverUserTurn: trimShortText(old.carryOverUserTurn, getCarryOverMaxChars()),
    presence: normalizeShortTermPresence(old.presence),
    lastCompressedAt: Number(old.lastCompressedAt || 0) || 0,
    rounds: Number(old.rounds || 0) || 0
  };
}

function resolveShortTermSessionKey(userId, routeMeta = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';

  if (!config.SHORT_TERM_SESSION_SCOPE_ENABLED) {
    return uid;
  }

  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const explicitSessionId = String(meta.sessionId || meta.session_id || '').trim();
  if (explicitSessionId) return explicitSessionId;

  const groupId = String(meta.groupId || meta.group_id || '').trim();
  if (groupId) return `qq-group:${groupId}:user:${uid}`;

  const channelId = String(meta.channelId || meta.channel_id || '').trim();
  if (channelId) return `channel:${channelId}:user:${uid}`;

  return `direct:${uid}`;
}

function resolveShortTermScope(userId, routeMeta = {}, sessionKey = '') {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  return {
    sessionKey: String(sessionKey || resolveShortTermSessionKey(userId, meta) || '').trim(),
    userId: String(userId || '').trim(),
    groupId: String(meta.groupId || meta.group_id || '').trim(),
    channelId: String(meta.channelId || meta.channel_id || '').trim(),
    sessionId: String(meta.sessionId || meta.session_id || '').trim()
  };
}

function ensureShortTermMemoryState(target, shortTermMemory = {}, routeMeta = {}) {
  const rawTarget = String(target || '').trim();
  const hasRouteMeta = routeMeta && typeof routeMeta === 'object' && Object.keys(routeMeta).length > 0;
  const key = String(hasRouteMeta ? resolveShortTermSessionKey(rawTarget, routeMeta) : rawTarget || '').trim();
  if (!key) return defaultShortTermState();

  shortTermMemory[key] = normalizeShortTermState(shortTermMemory[key]);
  return shortTermMemory[key];
}

function getShortTermPresence(target, shortTermMemory = {}, routeMeta = {}) {
  const state = ensureShortTermMemoryState(target, shortTermMemory, routeMeta);
  return normalizeShortTermPresence(state.presence);
}

function updateShortTermPresence(target, shortTermMemory = {}, routeMeta = {}, updater) {
  const state = ensureShortTermMemoryState(target, shortTermMemory, routeMeta);
  const current = normalizeShortTermPresence(state.presence);
  const next = typeof updater === 'function'
    ? updater({ ...current })
    : { ...current, ...(updater && typeof updater === 'object' ? updater : {}) };

  state.presence = normalizeShortTermPresence(next);
  return normalizeShortTermPresence(state.presence);
}

function joinProfileValues(values = [], limit = 4) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 1))
    .join(', ');
}

function compactFactTextForRecall(factText, maxLines = 4) {
  const lines = String(factText || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxLines) || 1));

  return lines.join(' | ');
}

function buildRestartRecallSummary(userId, question = '', userInfo = {}, options = {}) {
  const key = String(userId || '').trim();
  if (!key) return { summary: '', hitCount: 0 };

  const settings = getShortTermCompressionSettings(userInfo, { userId: key });
  const profile = getUserProfile(key) || {};
  const summary = String(getUserSummary(key) || '').trim();
  const impression = String(getUserImpression(key) || '').trim();
  const factText = String(getUserMemories(key) || '').trim();
  const hits = retrieveRelevantMemories(
    key,
    String(question || '').trim(),
    Number(options.topK || config.MEMORY_RAG_TOP_K || 8),
    {
      scopeType: 'personal',
      trackAccess: false
    }
  );

  const sections = [];
  const relevantHitTexts = hits
    .map((item) => trimTextByTokenBudget(String(item?.text || '').trim(), 80, 'tail'))
    .filter(Boolean)
    .slice(0, 4);

  if (relevantHitTexts.length > 0) {
    sections.push(`[RelevantRecall] ${relevantHitTexts.join(' | ')}`);
  }

  if (summary) {
    sections.push(`[KnownSummary] ${trimTextByTokenBudget(summary, 110, 'tail')}`);
  }

  if (impression) {
    sections.push(`[KnownImpression] ${trimTextByTokenBudget(impression, 90, 'tail')}`);
  }

  const identities = joinProfileValues(profile.identities, 4);
  if (identities) sections.push(`[Identity] ${identities}`);

  const likes = joinProfileValues(profile.likes, 4);
  if (likes) sections.push(`[Likes] ${likes}`);

  const dislikes = joinProfileValues(profile.dislikes, 3);
  if (dislikes) sections.push(`[Dislikes] ${dislikes}`);

  const goals = joinProfileValues(profile.goals, 4);
  if (goals) sections.push(`[Goals] ${goals}`);

  const recentTopics = joinProfileValues(profile.recent_topics, 4);
  if (recentTopics) sections.push(`[RecentTopics] ${recentTopics}`);

  const facts = compactFactTextForRecall(factText === '目前没有特别记忆。' ? '' : factText, 4);
  if (facts) sections.push(`[KnownFacts] ${facts}`);

  const summaryText = trimTextByTokenBudget(
    sections.join('\n'),
    settings.summaryMaxTokens,
    'tail'
  );

  return {
    summary: summaryText,
    hitCount: relevantHitTexts.length
  };
}

function shouldAttemptRestartRecall(userId, deps = {}) {
  const key = String(deps.sessionKey || '').trim();
  const uid = String(userId || '').trim();
  if (!uid || !key) return false;
  if (!config.RESTART_RECALL_ENABLED) return false;

  const historyStore = deps.chatHistory || {};
  const history = Array.isArray(historyStore[key]) ? historyStore[key] : [];
  if (history.length > 0) return false;

  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  if (String(state.summary || '').trim()) return false;

  return true;
}

function rehydrateShortTermMemoryAfterRestartIfNeeded(userId, question = '', userInfo = {}, deps = {}) {
  const uid = String(userId || '').trim();
  const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  if (!shouldAttemptRestartRecall(uid, { ...deps, sessionKey })) {
    return { rehydrated: false, hitCount: 0, summaryLength: 0 };
  }

  const state = ensureShortTermMemoryState(sessionKey, deps.shortTermMemory);
  const reconstructed = buildRestartRecallSummary(uid, question, userInfo, deps);
  const summaryText = String(reconstructed.summary || '').trim();
  if (!summaryText) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] restart recall skipped: no personal memory to restore', {
        userId: uid,
        sessionKey
      });
    }
    return { rehydrated: false, hitCount: Number(reconstructed.hitCount || 0) || 0, summaryLength: 0 };
  }

  state.summary = summaryText;
  state.lastCompressedAt = Date.now();

  if (config.ENABLE_DEBUG_LOG) {
    console.log('[memory] restart recall restored short-term summary', {
      userId: uid,
      sessionKey,
      hits: Number(reconstructed.hitCount || 0) || 0,
      summaryLength: summaryText.length
    });
  }

  return {
    rehydrated: true,
    hitCount: Number(reconstructed.hitCount || 0) || 0,
    summaryLength: summaryText.length
  };
}

function buildStructuredSummaryText(shortTermState, summaryTokens) {
  const state = normalizeShortTermState(shortTermState);
  const sections = [];

  if (state.carryOverUserTurn) {
    sections.push(`[UnresolvedUserTurn] ${state.carryOverUserTurn}`);
  }
  if (state.activeTopic) {
    sections.push(`[ActiveTopic] ${state.activeTopic}`);
  }
  if (state.openLoops.length > 0) {
    sections.push(`[OpenLoops] ${state.openLoops.join(' | ')}`);
  }
  if (state.assistantCommitments.length > 0) {
    sections.push(`[AssistantCommitments] ${state.assistantCommitments.join(' | ')}`);
  }
  if (state.userConstraints.length > 0) {
    sections.push(`[UserConstraints] ${state.userConstraints.join(' | ')}`);
  }
  if (state.recentToolResults.length > 0) {
    sections.push(`[RecentToolResults] ${state.recentToolResults.join(' | ')}`);
  }
  if (state.summary) {
    sections.push(`[Summary] ${state.summary}`);
  }

  return trimTextByTokenBudget(sections.join('\n'), summaryTokens, 'tail');
}

function buildHistorySummaryMessage(summaryText, summaryTokens) {
  const text = trimTextByTokenBudget(String(summaryText || '').trim(), summaryTokens, 'tail');
  if (!text) return null;

  return {
    role: 'system',
    content: [
      '[ShortTermSummary]',
      'Compressed summary of earlier conversation. Treat this as recent context, not long-term memory.',
      text
    ].join('\n')
  };
}

function normalizeContinuityText(text = '') {
  return String(text || '')
    .replace(/^\s*\d+\.\s*/gm, '')
    .replace(/^\s*\[[^\]\n]+\]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeHistoryMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function listUserSessionKeys(userId, chatHistory = {}, shortTermMemory = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];

  const sessionKeys = new Set();
  for (const key of Object.keys(chatHistory || {})) {
    const sessionKey = String(key || '').trim();
    if (
      sessionKey === `direct:${uid}`
      || sessionKey.startsWith(`qq-group:`) && sessionKey.endsWith(`:user:${uid}`)
      || sessionKey.startsWith(`channel:`) && sessionKey.endsWith(`:user:${uid}`)
    ) {
      sessionKeys.add(sessionKey);
    }
  }
  for (const key of Object.keys(shortTermMemory || {})) {
    const sessionKey = String(key || '').trim();
    if (
      sessionKey === `direct:${uid}`
      || sessionKey.startsWith(`qq-group:`) && sessionKey.endsWith(`:user:${uid}`)
      || sessionKey.startsWith(`channel:`) && sessionKey.endsWith(`:user:${uid}`)
    ) {
      sessionKeys.add(sessionKey);
    }
  }
  return Array.from(sessionKeys);
}

function buildSharedShortTermSignature(sessionEntries = []) {
  return (Array.isArray(sessionEntries) ? sessionEntries : [])
    .map((entry) => {
      const sessionKey = String(entry?.sessionKey || '').trim();
      const updatedAt = Number(entry?.updatedAt || 0) || 0;
      const historyLength = Number(entry?.historyLength || 0) || 0;
      return `${sessionKey}@${updatedAt}:${historyLength}`;
    })
    .filter(Boolean)
    .join('|');
}

function collectSharedShortTermSessionEntries(userId, deps = {}) {
  const uid = String(userId || '').trim();
  const historyStore = deps.chatHistory || {};
  const shortTermStore = deps.shortTermMemory || {};
  const currentSessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  const allSessionKeys = listUserSessionKeys(uid, historyStore, shortTermStore);
  if (currentSessionKey && !allSessionKeys.includes(currentSessionKey)) {
    allSessionKeys.push(currentSessionKey);
  }

  const entries = allSessionKeys.map((sessionKey) => {
    const state = ensureShortTermMemoryState(sessionKey, shortTermStore);
    const history = normalizeHistoryMessages(historyStore[sessionKey]);
    const presence = normalizeShortTermPresence(state.presence);
    const updatedAt = Math.max(
      Number(state.lastCompressedAt || 0) || 0,
      Number(presence.stateUpdatedAt || 0) || 0,
      Number(presence.lastInboundAt || 0) || 0,
      history.length > 0 ? history.length : 0
    );
    return {
      sessionKey,
      state: normalizeShortTermState(state),
      history,
      historyLength: history.length,
      updatedAt,
      isCurrent: sessionKey === currentSessionKey
    };
  });

  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''));
  });
  return entries;
}

function mergeSharedStringList(entries = [], selector, limit = 4, itemMaxChars = 140) {
  const current = entries.find((entry) => entry?.isCurrent);
  const preferred = normalizeStringList(
    typeof selector === 'function' ? selector(current?.state || {}) : [],
    limit,
    itemMaxChars
  );
  if (preferred.length >= limit) return preferred;

  const deduped = preferred.slice();
  const seen = new Set(deduped);
  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    const values = normalizeStringList(
      typeof selector === 'function' ? selector(entry.state || {}) : [],
      limit,
      itemMaxChars
    );
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      deduped.push(value);
      if (deduped.length >= limit) return deduped;
    }
  }
  return deduped;
}

function pickSharedField(entries = [], selector, maxChars = 220) {
  for (const entry of entries) {
    const value = trimShortText(typeof selector === 'function' ? selector(entry?.state || {}) : '', maxChars);
    if (value) return value;
  }
  return '';
}

function buildSharedRecentHistory(entries = [], tokenBudget = 0) {
  const current = entries.find((entry) => entry?.isCurrent);
  const combined = [];
  const seen = new Set();

  const pushHistory = (messages = []) => {
    for (const item of messages) {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) continue;
      const key = `${role}:${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push({ role, content });
    }
  };

  pushHistory(current?.history || []);
  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    pushHistory(entry.history || []);
  }

  return trimMessagesByTokenBudget(combined, tokenBudget);
}

function buildSharedShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const sessionEntries = collectSharedShortTermSessionEntries(userId, {
    ...deps,
    sessionKey: key
  });
  const sharedState = normalizeShortTermState({
    summary: pickSharedField(sessionEntries, (state) => state.summary, 2400),
    activeTopic: pickSharedField(sessionEntries, (state) => state.activeTopic, 180),
    openLoops: mergeSharedStringList(sessionEntries, (state) => state.openLoops, getStateMaxItems(), 120),
    assistantCommitments: mergeSharedStringList(sessionEntries, (state) => state.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: mergeSharedStringList(sessionEntries, (state) => state.userConstraints, getStateMaxItems(), 120),
    recentToolResults: mergeSharedStringList(sessionEntries, (state) => state.recentToolResults, getToolResultMaxItems(), 160),
    carryOverUserTurn: pickSharedField(sessionEntries, (state) => state.carryOverUserTurn, getCarryOverMaxChars()),
    presence: (sessionEntries.find((entry) => entry?.isCurrent)?.state || defaultShortTermState()).presence
  });
  const summaryText = buildStructuredSummaryText(sharedState, settings.summaryMaxTokens);
  const summaryMessage = buildHistorySummaryMessage(summaryText, settings.summaryMaxTokens);
  const historyStore = deps.chatHistory || {};
  const currentHistory = Array.isArray(historyStore[key]) ? historyStore[key] : [];
  const sessionSummaryBundle = buildSessionSummaryMessages(
    key,
    currentHistory,
    config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT,
    { dedupeAgainstText: summaryText }
  );
  const recentHistory = buildSharedRecentHistory(sessionEntries, settings.affinity.shortTermMemoryTokens);

  return {
    summaryMessage,
    sessionSummaryMessages: sessionSummaryBundle.sessionSummaryMessages,
    recentSessionSummaries: sessionSummaryBundle.recentSessionSummaries,
    recentHistory,
    affinity: settings.affinity,
    shortTermSummary: summaryText,
    shortTermState: sharedState,
    sessionKey: key,
    sharedSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    sharedShortTermSignature: buildSharedShortTermSignature(sessionEntries)
  };
}

function isContinuityDuplicate(candidate = '', baseline = '') {
  const normalizedCandidate = normalizeContinuityText(candidate);
  const normalizedBaseline = normalizeContinuityText(baseline);
  if (!normalizedCandidate || !normalizedBaseline) return false;
  if (normalizedCandidate === normalizedBaseline) return true;

  const shorterLength = Math.min(normalizedCandidate.length, normalizedBaseline.length);
  if (shorterLength < 18) return false;

  return normalizedBaseline.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedBaseline);
}

function filterSessionSummariesForFirstTurn(items = [], dedupeAgainstText = '') {
  const list = Array.isArray(items) ? items : [];
  const filtered = [];
  const seen = new Set();

  for (const item of list) {
    const summary = String(item?.summary || '').trim();
    const normalizedSummary = normalizeContinuityText(summary);
    if (!summary || !normalizedSummary || seen.has(normalizedSummary)) continue;
    if (isContinuityDuplicate(summary, dedupeAgainstText)) continue;
    seen.add(normalizedSummary);
    filtered.push(item);
  }

  return filtered;
}

function buildSessionSummaryMessages(
  sessionKey = '',
  history = [],
  loadCount = config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT,
  options = {}
) {
  const key = String(sessionKey || '').trim();
  const existingHistory = Array.isArray(history) ? history : [];
  if (!key || existingHistory.length > 0) {
    return {
      sessionSummaryMessages: [],
      recentSessionSummaries: []
    };
  }

  const recentSessionSummaries = getRecentSessionContextSummaries(key, { limit: loadCount });
  const filteredSessionSummaries = filterSessionSummariesForFirstTurn(
    recentSessionSummaries,
    options.dedupeAgainstText
  );
  if (filteredSessionSummaries.length === 0) {
    return {
      sessionSummaryMessages: [],
      recentSessionSummaries: []
    };
  }

  const content = [
    '[RecentSessionSummaries]',
    'Recent restart-recovery summaries for this exact session. Treat them as high-priority continuity context for the first turn after restart.',
    ...filteredSessionSummaries.map((item, index) => `${index + 1}. ${String(item.summary || '').trim()}`)
  ].join('\n');

  return {
    sessionSummaryMessages: [{ role: 'system', content }],
    recentSessionSummaries: filteredSessionSummaries
  };
}

function serializeHistoryChunk(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
      const content = trimTextByTokenBudget(normalizeMessageContent(item?.content), 220, 'tail');
      return `${role}: ${content || '[empty]'}`;
    })
    .filter(Boolean)
    .join('\n');
}

function mergeCompressedSummary(previousSummary, chunkSummary, summaryTokens) {
  const older = trimTextByTokenBudget(String(previousSummary || '').trim(), Math.floor(summaryTokens * 0.45), 'tail');
  const newer = trimTextByTokenBudget(String(chunkSummary || '').trim(), Math.floor(summaryTokens * 0.55), 'tail');

  if (older && newer) {
    return trimTextByTokenBudget(`[Earlier]\n${older}\n\n[Added]\n${newer}`, summaryTokens, 'tail');
  }

  return trimTextByTokenBudget(older || newer, summaryTokens, 'tail');
}

function getCompressionCandidateChunk(history = [], reserveRecentMessages = 2) {
  const list = Array.isArray(history) ? history : [];
  const reserve = Math.max(2, Number(reserveRecentMessages) || 2);
  const chunkEnd = Math.max(0, list.length - reserve);
  if (chunkEnd < 4) return [];

  const maxChunk = Math.max(4, Math.min(16, chunkEnd));
  const chunk = list.slice(0, maxChunk);
  return chunk.length >= 4 ? chunk : [];
}

function stripMarkdownFence(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? String(fenced[1] || '').trim() : raw;
}

function parseStructuredCompressionOutput(output = '') {
  const raw = stripMarkdownFence(output);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeShortTermState(parsed);
  } catch (_) {
    return null;
  }
}

function mergeStructuredState(currentState, nextState, summaryTokens) {
  const current = normalizeShortTermState(currentState);
  const next = normalizeShortTermState(nextState);
  return {
    ...current,
    activeTopic: next.activeTopic || current.activeTopic,
    openLoops: normalizeStringList(
      [...(next.openLoops || []), ...(current.openLoops || [])],
      getStateMaxItems(),
      120
    ),
    assistantCommitments: normalizeStringList(
      [...(next.assistantCommitments || []), ...(current.assistantCommitments || [])],
      getStateMaxItems(),
      120
    ),
    userConstraints: normalizeStringList(
      [...(next.userConstraints || []), ...(current.userConstraints || [])],
      getStateMaxItems(),
      120
    ),
    recentToolResults: normalizeStringList(
      [...(next.recentToolResults || []), ...(current.recentToolResults || [])],
      getToolResultMaxItems(),
      160
    ),
    carryOverUserTurn: next.carryOverUserTurn || current.carryOverUserTurn,
    summary: mergeCompressedSummary(current.summary, next.summary, summaryTokens),
    lastCompressedAt: Date.now(),
    rounds: Number(current.rounds || 0)
  };
}

async function compressShortTermHistoryIfNeeded(userId, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const historyStore = deps.chatHistory || {};
  if (!historyStore[key]) historyStore[key] = [];

  const history = historyStore[key];
  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  const summarizeChunk = typeof deps.summarizeChunk === 'function' ? deps.summarizeChunk : null;
  if (!summarizeChunk) return { compressed: false, summary: state.summary, history, state };

  let compressed = false;
  let rounds = 0;

  while (
    history.length > settings.reserveRecentMessages + 2 &&
    estimateMessagesTokens(history) > settings.triggerTokens &&
    rounds < settings.maxCompressionRounds
  ) {
    const chunk = getCompressionCandidateChunk(history, settings.reserveRecentMessages);
    if (chunk.length < 4) break;

    const chunkText = serializeHistoryChunk(chunk);
    if (!chunkText) break;

    const chunkSummary = await summarizeChunk({
      userId: String(userId || '').trim(),
      sessionKey: key,
      userInfo,
      existingSummary: state.summary,
      existingState: normalizeShortTermState(state),
      chunkMessages: chunk,
      chunkText,
      summaryTokens: settings.summaryMaxTokens
    });

    const normalizedOutput = String(chunkSummary || '').trim();
    if (!normalizedOutput) break;

    const structured = parseStructuredCompressionOutput(normalizedOutput);
    if (structured) {
      const merged = mergeStructuredState(state, structured, settings.summaryMaxTokens);
      Object.assign(state, merged);
    } else {
      const normalizedSummary = trimTextByTokenBudget(normalizedOutput, settings.summaryMaxTokens, 'tail');
      if (!normalizedSummary) break;
      state.summary = mergeCompressedSummary(state.summary, normalizedSummary, settings.summaryMaxTokens);
      state.lastCompressedAt = Date.now();
    }

    state.rounds += 1;
    history.splice(0, chunk.length);
    compressed = true;
    rounds += 1;
  }

  return {
    compressed,
    summary: state.summary,
    history,
    state: normalizeShortTermState(state)
  };
}

function buildShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  return buildSharedShortTermContextMessages(userId, userInfo, deps);
}

function appendShortTermHistory(userId, userContent, assistantContent, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const historyStore = deps.chatHistory || {};
  if (!historyStore[key]) historyStore[key] = [];

  historyStore[key].push({ role: 'user', content: userContent });
  historyStore[key].push({ role: 'assistant', content: assistantContent });

  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const maxKeep = settings.affinity.highAffinity
    ? Math.max(settings.reserveRecentMessages + 12, Number(config.MAX_HISTORY || 15) * 8)
    : Math.max(settings.reserveRecentMessages + 6, Number(config.MAX_HISTORY || 15) * 3);

  if (historyStore[key].length > maxKeep) {
    historyStore[key] = historyStore[key].slice(-maxKeep);
  }

  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  state.carryOverUserTurn = '';

  return historyStore[key];
}

function buildStructuredCompressionPrompt(existingState, summaryTokens) {
  const state = normalizeShortTermState(existingState);
  const compactState = {
    summary: state.summary,
    activeTopic: state.activeTopic,
    openLoops: state.openLoops,
    assistantCommitments: state.assistantCommitments,
    userConstraints: state.userConstraints,
    recentToolResults: state.recentToolResults,
    carryOverUserTurn: state.carryOverUserTurn
  };
  return [
    '你是对话短期上下文压缩器。',
    '优先保留：用户约束、助手承诺、未完成事项、最近工具结论、最近主线话题。',
    '返回严格 JSON，不要解释，不要 markdown。',
    '字段固定：summary, activeTopic, openLoops, assistantCommitments, userConstraints, recentToolResults, carryOverUserTurn。',
    `summary 控制在约 ${summaryTokens} tokens 内。`,
    'openLoops / assistantCommitments / userConstraints 最多 4 条，recentToolResults 最多 3 条。',
    `已有结构化状态：${JSON.stringify(compactState)}`
  ].join('\n');
}

module.exports = {
  defaultShortTermState,
  normalizeShortTermState,
  defaultShortTermPresence,
  normalizeShortTermPresence,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  ensureShortTermMemoryState,
  getShortTermPresence,
  updateShortTermPresence,
  buildHistorySummaryMessage,
  buildSessionSummaryMessages,
  normalizeContinuityText,
  isContinuityDuplicate,
  filterSessionSummariesForFirstTurn,
  buildStructuredSummaryText,
  buildStructuredCompressionPrompt,
  parseStructuredCompressionOutput,
  compressShortTermHistoryIfNeeded,
  buildSharedShortTermContextMessages,
  buildShortTermContextMessages,
  appendShortTermHistory,
  getShortTermCompressionSettings,
  rehydrateShortTermMemoryAfterRestartIfNeeded,
  buildSharedShortTermSignature
};
