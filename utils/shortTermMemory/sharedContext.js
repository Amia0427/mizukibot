const config = require('../../config');
const {
  normalizeMessageContent,
  trimMessagesByTokenBudget
} = require('../contextBudget');
const {
  DEFAULT_REPLY_POSTURE,
  getShortTermCompressionSettings,
  getStateMaxItems,
  getToolResultMaxItems,
  getCarryOverMaxChars,
  getStyleAnchorMaxItems,
  getRecentTurnsMaxItems,
  getSceneRecentTurnsMaxItems,
  trimShortText,
  normalizeStringList,
  normalizeConfidence,
  normalizeRecentTurns,
  defaultShortTermState,
  normalizeShortTermPresence,
  normalizeShortTermState,
  resolveShortTermSessionKey,
  ensureShortTermMemoryState
} = require('./state');
const {
  applyContextProfileToTokenBudget,
  resolveShortTermContextProfile
} = require('./contextProfile');
const { isUnsafeUserFacingReply } = require('../userFacingReplyGuards');

const shortTermScopeLogCache = new Map();

function listUserSessionKeys(userId, chatHistory = {}, shortTermMemory = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];

  const sessionKeys = new Set();
  for (const key of Object.keys(chatHistory || {})) {
    const sessionKey = String(key || '').trim();
    if (
      sessionKey === `direct:${uid}`
      || sessionKey === uid
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
      || sessionKey === uid
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

function shouldIncludeSiblingShortTermSessions(deps = {}) {
  if (deps.isolateSession === true || deps.currentSessionOnly === true) return false;
  const raw = deps.includeSiblingSessions ?? deps.includeSharedSessions ?? deps.shareAcrossSessions;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === false || raw === 0) return false;
  if (raw === true || raw === 1) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'false' || text === '0' || text === 'no') return false;
  return text === 'true' || text === '1' || text === 'yes';
}

function isSessionKeyForUser(sessionKey = '', userId = '') {
  const key = String(sessionKey || '').trim();
  const uid = String(userId || '').trim();
  if (!key || !uid) return false;
  return (
    key === uid
    || key === `direct:${uid}`
    || (key.startsWith('qq-group:') && key.endsWith(`:user:${uid}`))
    || (key.startsWith('channel:') && key.endsWith(`:user:${uid}`))
  );
}

function pruneShortTermScopeLogCache(now = Date.now()) {
  if (shortTermScopeLogCache.size <= 200) return;
  const cutoff = now - 60 * 1000;
  for (const [key, value] of shortTermScopeLogCache.entries()) {
    if (Number(value || 0) < cutoff) shortTermScopeLogCache.delete(key);
  }
}

function logShortTermScopeDecision(userId, sessionKey, scopeMeta = {}) {
  if (!config.ENABLE_DEBUG_LOG) return;
  const selectedSessionKeys = Array.isArray(scopeMeta.selectedSessionKeys) ? scopeMeta.selectedSessionKeys : [];
  const ignoredSessionKeys = Array.isArray(scopeMeta.ignoredSessionKeys) ? scopeMeta.ignoredSessionKeys : [];
  if (selectedSessionKeys.length <= 1 && ignoredSessionKeys.length === 0) return;

  const mode = String(scopeMeta.mode || '').trim() || 'session';
  const now = Date.now();
  const signature = [
    String(userId || '').trim(),
    String(sessionKey || '').trim(),
    mode,
    selectedSessionKeys.join(','),
    ignoredSessionKeys.join(',')
  ].join('|');
  const previousAt = Number(shortTermScopeLogCache.get(signature) || 0) || 0;
  if (previousAt && now - previousAt < 60 * 1000) return;
  shortTermScopeLogCache.set(signature, now);
  pruneShortTermScopeLogCache(now);

  console.log('[short-term-memory] session scope decision', {
    userId: String(userId || '').trim(),
    sessionKey: String(sessionKey || '').trim(),
    mode,
    selectedSessionKeys,
    selectedSessions: Array.isArray(scopeMeta.selectedSessions) ? scopeMeta.selectedSessions : [],
    ignoredSessionKeys
  });
}

function shouldOmitAssistantRawForSession(sessionKey = '', routeMeta = {}, options = {}) {
  if (options.sameUser === true) return false;
  const key = String(sessionKey || '').trim();
  if (/^(?:qq-group|channel):/i.test(key)) return false;
  if (/^direct:/i.test(key)) return options.isCurrent !== true;

  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const chatType = String(meta.chatType || meta.chat_type || '').trim().toLowerCase();
  if (chatType === 'private') return options.isCurrent !== true;
  if (chatType) return false;
  if (String(meta.groupId || meta.group_id || meta.channelId || meta.channel_id || '').trim()) return false;
  return false;
}

function normalizeHistoryMessages(messages = [], options = {}) {
  const omitAssistant = options.omitAssistant === true;
  return (Array.isArray(messages) ? messages : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) return null;
      if (omitAssistant && role === 'assistant') return null;
      if (role === 'assistant' && isUnsafeUserFacingReply(content)) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function collectSharedShortTermSessionEntries(userId, deps = {}) {
  const uid = String(userId || '').trim();
  const historyStore = deps.chatHistory || {};
  const shortTermStore = deps.shortTermMemory || {};
  const currentSessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  const includeSiblingSessions = shouldIncludeSiblingShortTermSessions(deps);
  const availableSessionKeys = listUserSessionKeys(uid, historyStore, shortTermStore);
  const selectedKeys = includeSiblingSessions ? availableSessionKeys.slice() : [];
  if (currentSessionKey && !selectedKeys.includes(currentSessionKey)) {
    selectedKeys.push(currentSessionKey);
  }

  const entries = selectedKeys.map((sessionKey) => {
    const isCurrent = sessionKey === currentSessionKey;
    const omitAssistantRaw = shouldOmitAssistantRawForSession(sessionKey, deps.routeMeta, {
      isCurrent,
      sameUser: isSessionKeyForUser(sessionKey, uid)
    });
    const state = ensureShortTermMemoryState(sessionKey, shortTermStore);
    const history = normalizeHistoryMessages(historyStore[sessionKey], { omitAssistant: omitAssistantRaw });
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
      isCurrent,
      omitAssistantRaw
    };
  });

  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''));
  });
  const selectedSessionKeys = entries.map((entry) => entry.sessionKey);
  const selectedSessions = entries.map((entry) => ({
    sessionKey: entry.sessionKey,
    current: Boolean(entry.isCurrent),
    updatedAt: Number(entry.updatedAt || 0) || 0,
    historyLength: Number(entry.historyLength || 0) || 0
  }));
  entries.scopeMeta = {
    mode: includeSiblingSessions ? 'shared' : 'session',
    currentSessionKey,
    availableSessionKeys,
    selectedSessionKeys,
    selectedSessions,
    ignoredSessionKeys: availableSessionKeys.filter((sessionKey) => !selectedSessionKeys.includes(sessionKey))
  };
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

function getMessageImportanceScore(message = {}, index = 0, total = 0) {
  const role = String(message?.role || '').trim().toLowerCase();
  const content = normalizeMessageContent(message?.content);
  let score = Math.max(0, Number(index || 0) || 0) / Math.max(1, Number(total || 1) || 1);
  const textLength = String(content || '').trim().length;
  if (message?.isCurrent) score += 0.8;
  if (role === 'user') score += 0.15;
  if (/(引用|回复|quote|quoted|>|\[quote\]|转发|上面这句|这句话)/i.test(content)) score += 1.2;
  if (/(我会|我将|承诺|保证|稍后|等下|待会|下一步|TODO|todo|commit|提交|部署|修复|实现|测试|补上|继续做)/i.test(content)) score += 0.95;
  if (/(还没|未完成|没做完|待办|坑|open loop|pending|继续|接着|上次|刚才)/i.test(content)) score += 0.9;
  if (/(不对|不是|错了|纠正|更正|改成|应该是|你刚|你说过|别忘|不要忘)/i.test(content)) score += 1.05;
  if (textLength >= 80) score += 0.3;
  if (textLength >= 180) score += 0.35;
  if (/[`*_#{}[\]()/\\]|https?:\/\//i.test(content)) score += 0.2;
  return score;
}

function trimMessagesByImportanceAndTokenBudget(messages = [], tokenBudget = 0, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Math.max(0, Number(tokenBudget) || 0);
  const rawCount = list.length;
  const newestMin = Math.max(0, Math.floor(Number(options.newestMin || 0) || 0));
  const maxMessages = Math.max(0, Math.floor(Number(options.maxMessages || 0) || 0));
  const stats = {
    rawCount,
    selectedCount: 0,
    tokenBudget: budget,
    maxMessages,
    newestMin,
    selectedImportantCount: 0,
    selectedNewestCount: 0,
    trimReasons: []
  };

  if (!list.length || budget <= 0) {
    stats.trimReasons.push('empty_or_zero_budget');
    return { messages: [], stats };
  }

  const newestStart = Math.max(0, list.length - newestMin);
  const selectedIndexes = new Set();
  for (let index = newestStart; index < list.length; index += 1) {
    selectedIndexes.add(index);
  }

  const remaining = list
    .map((message, index) => ({
      index,
      message,
      score: getMessageImportanceScore(message, index, list.length)
    }))
    .filter((item) => !selectedIndexes.has(item.index))
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const selectLimit = maxMessages > 0 ? maxMessages : list.length;
  for (const item of remaining) {
    if (selectedIndexes.size >= selectLimit) break;
    selectedIndexes.add(item.index);
  }

  if (selectedIndexes.size < list.length) {
    stats.trimReasons.push('message_limit_importance_selection');
  }

  const candidates = Array.from(selectedIndexes)
    .sort((a, b) => a - b)
    .map((index) => list[index]);
  const trimmed = trimMessagesByTokenBudget(candidates, budget);
  if (trimmed.length < candidates.length) {
    stats.trimReasons.push('token_budget_tail_trim');
  }

  const keptKeys = new Set(trimmed.map((message) => `${String(message.role || '').trim().toLowerCase()}:${normalizeMessageContent(message.content)}`));
  const selectedImportantCount = remaining.filter((item) => keptKeys.has(`${String(item.message.role || '').trim().toLowerCase()}:${normalizeMessageContent(item.message.content)}`)).length;
  const selectedNewestCount = trimmed.filter((message) => message.isNewest === true).length;
  stats.selectedCount = trimmed.length;
  stats.selectedImportantCount = selectedImportantCount;
  stats.selectedNewestCount = selectedNewestCount;
  if (stats.selectedCount < rawCount && stats.trimReasons.length === 0) {
    stats.trimReasons.push('trimmed');
  }

  return {
    messages: trimmed.map((message) => {
      const { isCurrent, isNewest, ...clean } = message;
      return clean;
    }),
    stats
  };
}

function buildSharedRecentHistory(entries = [], tokenBudget = 0, options = {}) {
  const current = entries.find((entry) => entry?.isCurrent);
  const combined = [];
  const seen = new Set();

  const pushHistory = (messages = [], entry = null) => {
    for (const item of messages) {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) continue;
      const key = `${role}:${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push({ role, content, isCurrent: Boolean(entry?.isCurrent) });
    }
  };

  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    pushHistory(entry.history || [], entry);
  }
  pushHistory(current?.history || [], current);
  const newestStart = Math.max(0, combined.length - Math.max(0, Number(options.newestMin || 0) || 0));
  for (let index = newestStart; index < combined.length; index += 1) {
    combined[index].isNewest = true;
  }

  return trimMessagesByImportanceAndTokenBudget(combined, tokenBudget, options);
}

function collectSharedRecentTurns(entries = [], selector, limit = getRecentTurnsMaxItems()) {
  const ordered = [];
  const pushEntryTurns = (entry) => {
    const turns = typeof selector === 'function' ? selector(entry.state || {}) : [];
    const normalized = normalizeRecentTurns(turns, limit)
      .filter((item) => {
        const role = String(item?.role || '').trim().toLowerCase();
        if (role !== 'assistant') return true;
        if (entry.omitAssistantRaw === true) return false;
        return !isUnsafeUserFacingReply(item?.content);
      });
    ordered.push(...normalized);
  };
  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    pushEntryTurns(entry);
  }
  const current = entries.find((entry) => entry?.isCurrent);
  if (current) {
    pushEntryTurns(current);
  }
  return normalizeRecentTurns(ordered, limit);
}

function buildSharedShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const contextProfile = resolveShortTermContextProfile(userInfo, {
    ...deps,
    userId: String(userId || '').trim()
  });
  const sessionEntries = collectSharedShortTermSessionEntries(userId, {
    ...deps,
    sessionKey: key
  });
  const scopeMeta = sessionEntries.scopeMeta || {
    mode: 'session',
    currentSessionKey: key,
    availableSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    selectedSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    selectedSessions: sessionEntries.map((entry) => ({
      sessionKey: entry.sessionKey,
      current: Boolean(entry.isCurrent),
      updatedAt: Number(entry.updatedAt || 0) || 0,
      historyLength: Number(entry.historyLength || 0) || 0
    })),
    ignoredSessionKeys: []
  };
  logShortTermScopeDecision(userId, key, scopeMeta);
  const sharedState = normalizeShortTermState({
    summary: pickSharedField(sessionEntries, (state) => state.summary, 2400),
    activeTopic: pickSharedField(sessionEntries, (state) => state.activeTopic, 180),
    openLoops: mergeSharedStringList(sessionEntries, (state) => state.openLoops, getStateMaxItems(), 120),
    assistantCommitments: mergeSharedStringList(sessionEntries, (state) => state.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: mergeSharedStringList(sessionEntries, (state) => state.userConstraints, getStateMaxItems(), 120),
    recentToolResults: mergeSharedStringList(sessionEntries, (state) => state.recentToolResults, getToolResultMaxItems(), 160),
    carryOverUserTurn: pickSharedField(sessionEntries, (state) => state.carryOverUserTurn, getCarryOverMaxChars()),
    interaction: {
      activeTopic: pickSharedField(sessionEntries, (state) => state.interaction?.activeTopic || state.activeTopic, 180),
      carryOverUserTurn: pickSharedField(sessionEntries, (state) => state.interaction?.carryOverUserTurn || state.carryOverUserTurn, getCarryOverMaxChars()),
      openLoops: mergeSharedStringList(sessionEntries, (state) => state.interaction?.openLoops || state.openLoops, getStateMaxItems(), 120),
      assistantCommitments: mergeSharedStringList(sessionEntries, (state) => state.interaction?.assistantCommitments || state.assistantCommitments, getStateMaxItems(), 120),
      userConstraints: mergeSharedStringList(sessionEntries, (state) => state.interaction?.userConstraints || state.userConstraints, getStateMaxItems(), 120),
      recentTurns: collectSharedRecentTurns(
        sessionEntries,
        (state) => state.interaction?.recentTurns || [],
        getRecentTurnsMaxItems()
      ),
      phaseHint: pickSharedField(sessionEntries, (state) => state.interaction?.phaseHint || state.phaseHint, 48),
      sourceFlags: mergeSharedStringList(sessionEntries, (state) => state.interaction?.sourceFlags || [], 8, 80),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.interaction?.confidence, 0)),
        0
      )
    },
    expression: {
      replyPosture: pickSharedField(sessionEntries, (state) => state.expression?.replyPosture, 24) || DEFAULT_REPLY_POSTURE,
      warmth: pickSharedField(sessionEntries, (state) => state.expression?.warmth, 32),
      guardedness: pickSharedField(sessionEntries, (state) => state.expression?.guardedness, 32),
      initiative: pickSharedField(sessionEntries, (state) => state.expression?.initiative, 32),
      jargonMode: pickSharedField(sessionEntries, (state) => state.expression?.jargonMode, 32),
      cadenceHint: pickSharedField(sessionEntries, (state) => state.expression?.cadenceHint, 48),
      styleAnchors: mergeSharedStringList(sessionEntries, (state) => state.expression?.styleAnchors || [], getStyleAnchorMaxItems(), 96),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.expression?.confidence, 0)),
        0
      )
    },
    moduleState: {
      activePersonaModules: mergeSharedStringList(sessionEntries, (state) => state.moduleState?.activePersonaModules || [], 2, 64),
      stickyTurnsRemaining: Math.max(
        ...sessionEntries.map((entry) => Math.max(0, Number(entry?.state?.moduleState?.stickyTurnsRemaining || 0) || 0)),
        0
      ),
      switchReason: pickSharedField(sessionEntries, (state) => state.moduleState?.switchReason, 160),
      lastSurface: pickSharedField(sessionEntries, (state) => state.moduleState?.lastSurface, 32),
      lastTopicFingerprint: pickSharedField(sessionEntries, (state) => state.moduleState?.lastTopicFingerprint, 96),
      lastUpdatedAt: Math.max(
        ...sessionEntries.map((entry) => Number(entry?.state?.moduleState?.lastUpdatedAt || 0) || 0),
        0
      )
    },
    scene: {
      sceneKey: pickSharedField(sessionEntries, (state) => state.scene?.sceneKey || state.sceneRef, 96),
      activeTopic: pickSharedField(sessionEntries, (state) => state.scene?.activeTopic, 180),
      atmosphere: pickSharedField(sessionEntries, (state) => state.scene?.atmosphere, 120),
      activePair: pickSharedField(sessionEntries, (state) => state.scene?.activePair, 120),
      quoteAnchor: pickSharedField(sessionEntries, (state) => state.scene?.quoteAnchor, 180),
      jargonHints: mergeSharedStringList(sessionEntries, (state) => state.scene?.jargonHints || [], 4, 80),
      recentTurns: collectSharedRecentTurns(
        sessionEntries,
        (state) => state.scene?.recentTurns || [],
        getSceneRecentTurnsMaxItems()
      ),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.scene?.confidence, 0)),
        0
      )
    },
    phaseHint: pickSharedField(sessionEntries, (state) => state.phaseHint || state.interaction?.phaseHint, 48),
    sceneRef: pickSharedField(sessionEntries, (state) => state.sceneRef || state.scene?.sceneKey, 96),
    confidence: Math.max(
      ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.confidence, 0)),
      0
    ),
    presence: (sessionEntries.find((entry) => entry?.isCurrent)?.state || defaultShortTermState()).presence
  });
  const summaryText = deps.buildStructuredSummaryText(sharedState, settings.summaryMaxTokens);
  const summaryMessage = deps.buildHistorySummaryMessage(summaryText, settings.summaryMaxTokens);
  const historyStore = deps.chatHistory || {};
  const currentHistory = Array.isArray(historyStore[key]) ? historyStore[key] : [];
  const summaryLoadCount = Math.max(1, Math.floor(Number(deps.sessionSummaryLoadCount || contextProfile.summaryLoadCount || config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT) || 1));
  const sessionSummaryBundle = deps.buildSessionSummaryMessages(
    key,
    currentHistory,
    summaryLoadCount,
    { dedupeAgainstText: summaryText }
  );
  const recentHistoryResult = buildSharedRecentHistory(
    sessionEntries,
    applyContextProfileToTokenBudget(settings.affinity.shortTermMemoryTokens, contextProfile),
    {
      maxMessages: contextProfile.recentRawMessageLimit,
      newestMin: contextProfile.recentRawNewestMin
    }
  );
  const recentHistory = recentHistoryResult.messages;
  const rawStats = recentHistoryResult.stats || {};
  const sessionSummaryCount = Array.isArray(sessionSummaryBundle.recentSessionSummaries)
    ? sessionSummaryBundle.recentSessionSummaries.length
    : 0;

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
    sharedShortTermSignature: buildSharedShortTermSignature(sessionEntries),
    shortTermScope: scopeMeta,
    contextProfile: {
      name: contextProfile.name,
      reason: contextProfile.reason,
      recentRawMessageLimit: contextProfile.recentRawMessageLimit,
      recentRawNewestMin: contextProfile.recentRawNewestMin,
      rawTokenMultiplier: contextProfile.rawTokenMultiplier,
      summaryLoadCount
    },
    contextObservability: {
      rawTurnCount: Math.max(0, Number(rawStats.rawCount || 0) || 0),
      selectedRawTurnCount: recentHistory.length,
      selectedNewestRawTurnCount: Math.max(0, Number(rawStats.selectedNewestCount || 0) || 0),
      selectedImportantRawTurnCount: Math.max(0, Number(rawStats.selectedImportantCount || 0) || 0),
      sessionSummaryCount,
      shortTermSummaryChars: String(summaryText || '').length,
      trimReasons: Array.isArray(rawStats.trimReasons) ? rawStats.trimReasons : []
    }
  };
}

module.exports = {
  buildSharedShortTermContextMessages,
  buildSharedShortTermSignature,
  buildSharedRecentHistory,
  collectSharedShortTermSessionEntries,
  listUserSessionKeys,
  normalizeHistoryMessages,
  shouldOmitAssistantRawForSession,
  trimMessagesByImportanceAndTokenBudget
};
