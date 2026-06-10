const config = require('../../config');
const {
  STORE_FILE,
  defaultEdge,
  defaultGroupEntry,
  defaultSummary,
  ensureGroup,
  normalizeArray,
  normalizeEdge,
  normalizeId,
  normalizeMessage,
  normalizeMessageLog,
  normalizeSummary,
  normalizeText,
  nowMs,
  readStore,
  writeStore
} = require('./store');
const { createSocialContextGraphHelpers } = require('./graph');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_LIMIT = 400;
const ACTIVE_PAIR_WINDOW_MS = 90 * 1000;
const FAST_REPLY_WINDOW_MS = 60 * 1000;
const INITIATOR_WINDOW_MS = 120 * 1000;

const {
  applyGroupDeltaToMergedGraph,
  recomputeGroupEntry,
  toPairKey
} = createSocialContextGraphHelpers({
  ACTIVE_PAIR_WINDOW_MS,
  FAST_REPLY_WINDOW_MS,
  INITIATOR_WINDOW_MS,
  LOG_LIMIT,
  WINDOW_MS,
  defaultEdge,
  defaultGroupEntry,
  normalizeEdge,
  normalizeId,
  normalizeMessageLog,
  normalizeSummary,
  nowMs
});

function recordHumanGroupMessage(entry = {}) {
  if (!config.SOCIAL_CONTEXT_ENABLED) return null;
  const message = normalizeMessage(entry, 'human');
  if (!message.groupId || !message.senderId || !message.text) return null;
  const store = readStore();
  const group = ensureGroup(store, message.groupId);
  const previousGroup = {
    messageLog: Array.isArray(group.messageLog) ? group.messageLog.slice() : [],
    summary: normalizeSummary(group.summary),
    edges: { ...(group.edges || {}) }
  };
  group.messageLog = [...group.messageLog, message];
  store.groups[message.groupId] = recomputeGroupEntry(message.groupId, group);
  store.mergedGraph = applyGroupDeltaToMergedGraph(store.mergedGraph, message.groupId, previousGroup, store.groups[message.groupId]);
  writeStore(store);
  return message;
}

function recordBotReply(entry = {}) {
  if (!config.SOCIAL_CONTEXT_ENABLED) return null;
  const message = normalizeMessage(entry, 'bot');
  if (!message.groupId || !message.text) return null;
  const store = readStore();
  const group = ensureGroup(store, message.groupId);
  const previousGroup = {
    messageLog: Array.isArray(group.messageLog) ? group.messageLog.slice() : [],
    summary: normalizeSummary(group.summary),
    edges: { ...(group.edges || {}) }
  };
  group.messageLog = [...group.messageLog, message];
  store.groups[message.groupId] = recomputeGroupEntry(message.groupId, group);
  store.mergedGraph = applyGroupDeltaToMergedGraph(store.mergedGraph, message.groupId, previousGroup, store.groups[message.groupId]);
  writeStore(store);
  return message;
}

function getGroupSocialContext(groupId = '') {
  const store = readStore();
  const gid = normalizeId(groupId);
  return normalizeSummary(store.groups?.[gid]?.summary || defaultSummary());
}

function resolveEdge(groupId = '', fromUserId = '', toUserId = '') {
  const gid = normalizeId(groupId);
  const key = toPairKey(fromUserId, toUserId);
  if (!key) return defaultEdge();
  const store = readStore();
  const groupEdge = gid ? store.groups?.[gid]?.edges?.[key] : null;
  if (groupEdge && Number(groupEdge.totalInteractions || 0) > 0) return normalizeEdge(groupEdge);
  return normalizeEdge(store.mergedGraph?.edges?.[key] || defaultEdge());
}

function getRelationshipGraphForUser(userId = '', options = {}) {
  const uid = normalizeId(userId);
  const gid = normalizeId(options.groupId || options.group_id || '');
  const limit = Math.max(1, Math.min(10, Number(options.limit || 5) || 5));
  if (!uid) return [];
  const store = readStore();
  const scopedEdges = gid ? Object.values(store.groups?.[gid]?.edges || {}) : [];
  const sourceEdges = scopedEdges.filter((edge) => edge.fromUserId === uid || edge.toUserId === uid);
  const fallbackEdges = sourceEdges.length
    ? sourceEdges
    : Object.values(store.mergedGraph?.edges || {}).filter((edge) => edge.fromUserId === uid || edge.toUserId === uid);
  return fallbackEdges
    .map((edge) => normalizeEdge(edge))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

function inferActivePair(recentMessages = []) {
  const input = normalizeMessageLog(recentMessages);
  const humans = input.filter((item) => item.kind !== 'bot').slice(-6);
  if (humans.length < 4) return null;
  const speakerIds = [...new Set(humans.map((item) => item.senderId))];
  if (speakerIds.length !== 2) return null;
  return {
    userA: speakerIds[0],
    userB: speakerIds[1]
  };
}

function resolveExplicitReplyLockPair(recentMessages = [], senderId = '') {
  const normalizedSenderId = normalizeId(senderId);
  const input = normalizeMessageLog(recentMessages);
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    const replyToSenderId = normalizeId(item?.replyToSenderId);
    if (!replyToSenderId) continue;
    if (normalizedSenderId && item.senderId !== normalizedSenderId) continue;
    if (item.senderId === replyToSenderId) continue;
    return {
      userA: item.senderId,
      userB: replyToSenderId
    };
  }
  return null;
}

function shouldLockPassiveReply({ groupId = '', recentMessages = [], senderId = '', addressee = '', directedContext = null } = {}) {
  if (['bot_presence_check', 'bot_direct', 'group_bot_topic'].includes(String(addressee || ''))) {
    return { shouldLock: false, reason: 'bot-topic-override', pair: null };
  }
  const directedScene = normalizeText(directedContext?.scene, 40);
  if (directedScene === 'reply_to_user' || directedScene === 'human_pair_chat') {
    const targetUserId = normalizeId(directedContext?.addressee?.userId);
    if (normalizeId(senderId) && targetUserId) {
      return {
        shouldLock: true,
        reason: directedScene === 'reply_to_user' ? 'directed-reply-to-user' : 'directed-human-pair-chat',
        pair: {
          userA: normalizeId(senderId),
          userB: targetUserId
        }
      };
    }
  }
  const explicitPair = resolveExplicitReplyLockPair(recentMessages, senderId);
  if (explicitPair) {
    const edgeForward = resolveEdge(groupId, explicitPair.userB, explicitPair.userA);
    const edgeBackward = resolveEdge(groupId, explicitPair.userA, explicitPair.userB);
    const pairStrength = Number(edgeForward.strength || 0) + Number(edgeBackward.strength || 0);
    if (pairStrength >= 4) {
      return {
        shouldLock: true,
        reason: 'explicit-reply-lock',
        pair: explicitPair
      };
    }
  }
  const pair = inferActivePair(recentMessages);
  if (!pair) return { shouldLock: false, reason: 'no-active-pair', pair: null };
  const edgeAB = resolveEdge(groupId, pair.userA, pair.userB);
  const edgeBA = resolveEdge(groupId, pair.userB, pair.userA);
  const pairStrength = Number(edgeAB.strength || 0) + Number(edgeBA.strength || 0);
  if (pairStrength < 8) return { shouldLock: false, reason: 'pair-strength-low', pair };
  if (String(senderId || '') && ![pair.userA, pair.userB].includes(String(senderId || ''))) {
    return { shouldLock: false, reason: 'sender-outside-pair', pair };
  }
  return {
    shouldLock: true,
    reason: 'human-pair-lock',
    pair
  };
}

function buildSocialContextSnippet(input = {}) {
  if (!config.SOCIAL_CONTEXT_ENABLED) return '';
  const groupId = normalizeId(input.groupId || input.group_id || '');
  if (!groupId) return '';
  const summary = getGroupSocialContext(groupId);
  if (!summary.sampleCount || summary.sampleCount < 12) return '';
  const maxChars = Math.max(80, Number(input.maxChars || config.SOCIAL_CONTEXT_PROMPT_MAX_CHARS || 260));
  const lines = ['[SocialContext]'];
  if (summary.atmosphere) lines.push(`atmosphere=${summary.atmosphere}`);
  if (summary.topInitiators.length) lines.push(`initiators=${summary.topInitiators.map((item) => item.senderName || item.userId).join('/')}`);
  if (summary.topReplyPairs.length) lines.push(`reply_pairs=${summary.topReplyPairs.map((item) => item.names || `${item.userA}<->${item.userB}`).join('; ')}`);
  if (summary.topTeasePairs.length) lines.push(`tease_pairs=${summary.topTeasePairs.map((item) => item.names || `${item.userA}<->${item.userB}`).join('; ')}`);
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function buildPassiveAwarenessSocialSnippet(input = {}) {
  if (!config.SOCIAL_CONTEXT_ENABLED) return '';
  const groupId = normalizeId(input.groupId || input.group_id || '');
  if (!groupId) return '';
  const maxChars = Math.max(60, Number(input.maxChars || 180) || 180);
  const summary = getGroupSocialContext(groupId);
  if (!summary.sampleCount) return '';
  const lines = ['[SocialContext]'];
  if (summary.atmosphere) lines.push(`atmosphere=${summary.atmosphere}`);
  const lock = shouldLockPassiveReply({
    groupId,
    recentMessages: input.recentMessages,
    senderId: input.senderId,
    addressee: input.addressee,
    directedContext: input.directedContext
  });
  if (lock.pair) lines.push(`active_pair=${lock.pair.userA}<->${lock.pair.userB}`);
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function formatSocialContextAsText(groupId = '') {
  const summary = getGroupSocialContext(groupId);
  if (!summary.sampleCount) return '[SocialContext]\nno stable group context yet';
  return [
    '[SocialContext]',
    `atmosphere: ${summary.atmosphere || 'unknown'}`,
    `sample_count: ${summary.sampleCount}`,
    `distinct_users: ${summary.distinctUsers}`,
    `initiators: ${summary.topInitiators.map((item) => `${item.senderName || item.userId}(${item.count})`).join(', ') || 'none'}`,
    `reply_pairs: ${summary.topReplyPairs.map((item) => `${item.names || `${item.userA}<->${item.userB}`}(${item.strength})`).join(', ') || 'none'}`,
    `tease_pairs: ${summary.topTeasePairs.map((item) => `${item.names || `${item.userA}<->${item.userB}`}(${item.count})`).join(', ') || 'none'}`
  ].join('\n');
}

function formatRelationshipGraphAsText(userId = '', options = {}) {
  const edges = getRelationshipGraphForUser(userId, options);
  if (!edges.length) return '[RelationshipGraph]\nno stable edges yet';
  return [
    '[RelationshipGraph]',
    ...edges.map((edge) => `${edge.fromUserId}->${edge.toUserId} | strength=${edge.strength} | type=${edge.dominantType || 'reply'} | interactions=${edge.totalInteractions}`)
  ].join('\n');
}

module.exports = {
  STORE_FILE,
  buildPassiveAwarenessSocialSnippet,
  buildSocialContextSnippet,
  formatRelationshipGraphAsText,
  formatSocialContextAsText,
  getGroupSocialContext,
  getRelationshipGraphForUser,
  inferActivePair,
  readStore,
  recordBotReply,
  recordHumanGroupMessage,
  resolveEdge,
  resolveExplicitReplyLockPair,
  shouldLockPassiveReply
};
