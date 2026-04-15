const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createJsonHotStore } = require('./jsonHotStore');

const STORE_FILE = String(config.SOCIAL_CONTEXT_STORE_FILE || path.join(config.DATA_DIR, 'social_context.json')).trim();
const SOCIAL_STORE_DIR = path.join(path.dirname(STORE_FILE), 'social');
const SOCIAL_GROUP_DIR = path.join(SOCIAL_STORE_DIR, 'group');
const SOCIAL_MERGED_FILE = path.join(SOCIAL_STORE_DIR, 'merged_graph.json');
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_LIMIT = 400;
const ACTIVE_PAIR_WINDOW_MS = 90 * 1000;
const FAST_REPLY_WINDOW_MS = 60 * 1000;
const INITIATOR_WINDOW_MS = 120 * 1000;
const socialStores = {
  legacy: null,
  merged: null,
  groups: new Map()
};

function nowMs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, body, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function getLegacyStore() {
  if (!socialStores.legacy) {
    socialStores.legacy = createJsonHotStore(STORE_FILE, {
      fallback: defaultStore
    });
  }
  return socialStores.legacy;
}

function getMergedStore() {
  if (!socialStores.merged) {
    socialStores.merged = createJsonHotStore(SOCIAL_MERGED_FILE, {
      fallback: () => ({ edges: {} })
    });
  }
  return socialStores.merged;
}

function getGroupStore(groupId = '') {
  const gid = normalizeId(groupId);
  if (!gid) return null;
  if (!socialStores.groups.has(gid)) {
    socialStores.groups.set(gid, createJsonHotStore(path.join(SOCIAL_GROUP_DIR, `${encodeURIComponent(gid)}.json`), {
      fallback: defaultGroupEntry
    }));
  }
  return socialStores.groups.get(gid);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeText(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeId(value, maxChars = 80) {
  return normalizeText(value, maxChars);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeMessageId(entry = {}) {
  const messageId = normalizeId(entry.messageId || entry.message_id);
  if (messageId) return `msg:${messageId}`;
  return `${normalizeId(entry.groupId || entry.group_id)}:${normalizeId(entry.senderId || entry.sender_id)}:${Number(entry.timestamp || 0) || 0}:${normalizeText(entry.text || '', 80)}`;
}

function normalizeMessage(entry = {}, kind = 'human') {
  const text = normalizeText(entry.text || '', 240);
  const groupId = normalizeId(entry.groupId || entry.group_id);
  const senderId = normalizeId(entry.senderId || entry.sender_id || (kind === 'bot' ? config.BOT_QQ || 'bot' : ''));
  const senderName = normalizeText(entry.senderName || entry.sender_name || '', 80);
  const timestamp = Math.max(0, Number(entry.timestamp || nowMs()) || nowMs());
  const replyToMessageId = normalizeId(entry.replyToMessageId || entry.reply_to_message_id || entry.replyMessageId || entry.reply_message_id);
  const replyToSenderId = normalizeId(entry.replyToSenderId || entry.reply_to_sender_id || entry.replySenderId || entry.reply_sender_id);
  const replyToSenderName = normalizeText(entry.replyToSenderName || entry.reply_to_sender_name || entry.replySenderName || entry.reply_sender_name || '', 80);
  return {
    id: makeMessageId(entry),
    kind: kind === 'bot' ? 'bot' : 'human',
    groupId,
    senderId,
    senderName,
    text,
    timestamp,
    replyToMessageId,
    replyToSenderId,
    replyToSenderName
  };
}

function defaultSummary() {
  return {
    atmosphere: '',
    sampleCount: 0,
    distinctUsers: 0,
    topInitiators: [],
    topReplyPairs: [],
    topTeasePairs: [],
    updatedAt: 0
  };
}

function defaultEdge() {
  return {
    fromUserId: '',
    toUserId: '',
    totalInteractions: 0,
    fastReplyCount: 0,
    explicitReplyCount: 0,
    teaseCount: 0,
    supportCount: 0,
    conflictCount: 0,
    dominantType: '',
    strength: 0,
    groups: {},
    lastSeenAt: 0
  };
}

function defaultGroupEntry() {
  return {
    messageLog: [],
    summary: defaultSummary(),
    edges: {}
  };
}

function defaultStore() {
  return {
    version: 1,
    groups: {},
    mergedGraph: {
      edges: {}
    }
  };
}

function normalizeActorSummary(item = {}) {
  const raw = item && typeof item === 'object' ? item : {};
  const userId = normalizeId(raw.userId);
  if (!userId) return null;
  return {
    userId,
    senderName: normalizeText(raw.senderName, 40),
    count: Math.max(0, Number(raw.count || 0) || 0)
  };
}

function normalizePairSummary(item = {}) {
  const raw = item && typeof item === 'object' ? item : {};
  const userA = normalizeId(raw.userA);
  const userB = normalizeId(raw.userB);
  if (!userA || !userB) return null;
  return {
    userA,
    userB,
    names: normalizeText(raw.names, 80),
    count: Math.max(0, Number(raw.count || 0) || 0),
    strength: Math.max(0, Number(raw.strength || 0) || 0),
    dominantType: normalizeText(raw.dominantType, 24)
  };
}

function normalizeSummary(summary = {}) {
  const raw = summary && typeof summary === 'object' ? summary : {};
  return {
    atmosphere: normalizeText(raw.atmosphere, 16),
    sampleCount: Math.max(0, Number(raw.sampleCount || 0) || 0),
    distinctUsers: Math.max(0, Number(raw.distinctUsers || 0) || 0),
    topInitiators: normalizeArray(raw.topInitiators).map(normalizeActorSummary).filter(Boolean).slice(0, 4),
    topReplyPairs: normalizeArray(raw.topReplyPairs).map(normalizePairSummary).filter(Boolean).slice(0, 4),
    topTeasePairs: normalizeArray(raw.topTeasePairs).map(normalizePairSummary).filter(Boolean).slice(0, 4),
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0)
  };
}

function normalizeEdge(edge = {}) {
  const raw = edge && typeof edge === 'object' ? edge : {};
  const groups = raw.groups && typeof raw.groups === 'object' ? raw.groups : {};
  const normalizedGroups = {};
  for (const [groupId, count] of Object.entries(groups)) {
    const gid = normalizeId(groupId);
    if (!gid) continue;
    normalizedGroups[gid] = Math.max(0, Number(count || 0) || 0);
  }
  return {
    fromUserId: normalizeId(raw.fromUserId),
    toUserId: normalizeId(raw.toUserId),
    totalInteractions: Math.max(0, Number(raw.totalInteractions || 0) || 0),
    fastReplyCount: Math.max(0, Number(raw.fastReplyCount || 0) || 0),
    explicitReplyCount: Math.max(0, Number(raw.explicitReplyCount || 0) || 0),
    teaseCount: Math.max(0, Number(raw.teaseCount || 0) || 0),
    supportCount: Math.max(0, Number(raw.supportCount || 0) || 0),
    conflictCount: Math.max(0, Number(raw.conflictCount || 0) || 0),
    dominantType: normalizeText(raw.dominantType, 24),
    strength: Math.max(0, Number(raw.strength || 0) || 0),
    groups: normalizedGroups,
    lastSeenAt: Math.max(0, Number(raw.lastSeenAt || 0) || 0)
  };
}

function normalizeMessageLog(log = []) {
  const seen = new Set();
  const out = [];
  for (const item of normalizeArray(log)) {
    const normalized = normalizeMessage(item, item?.kind === 'bot' ? 'bot' : 'human');
    if (!normalized.groupId || !normalized.senderId || !normalized.text) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeStore(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const groups = raw.groups && typeof raw.groups === 'object' ? raw.groups : {};
  const normalizedGroups = {};
  for (const [groupId, entry] of Object.entries(groups)) {
    const gid = normalizeId(groupId);
    if (!gid) continue;
    const edges = entry?.edges && typeof entry.edges === 'object' ? entry.edges : {};
    const normalizedEdges = {};
    for (const [edgeKey, edge] of Object.entries(edges)) {
      normalizedEdges[String(edgeKey)] = normalizeEdge(edge);
    }
    normalizedGroups[gid] = {
      messageLog: normalizeMessageLog(entry?.messageLog),
      summary: normalizeSummary(entry?.summary),
      edges: normalizedEdges
    };
  }
  const mergedEdges = raw.mergedGraph?.edges && typeof raw.mergedGraph.edges === 'object' ? raw.mergedGraph.edges : {};
  const normalizedMergedEdges = {};
  for (const [edgeKey, edge] of Object.entries(mergedEdges)) {
    normalizedMergedEdges[String(edgeKey)] = normalizeEdge(edge);
  }
  return {
    version: 1,
    groups: normalizedGroups,
    mergedGraph: {
      edges: normalizedMergedEdges
    }
  };
}

function readStore() {
  ensureDir(STORE_FILE);
  const legacy = normalizeStore(getLegacyStore().read());
  const groups = {};
  for (const groupId of Object.keys(legacy.groups || {})) {
    const store = getGroupStore(groupId);
    if (!store) continue;
    groups[groupId] = normalizeStore({
      groups: {
        [groupId]: store.read()
      }
    }).groups[groupId];
  }
  return normalizeStore({
    version: 1,
    groups,
    mergedGraph: getMergedStore().read()
  });
}

function writeStore(store) {
  const normalized = normalizeStore(store);
  for (const [groupId, entry] of Object.entries(normalized.groups || {})) {
    const groupStore = getGroupStore(groupId);
    if (!groupStore) continue;
    groupStore.replace(entry);
  }
  getMergedStore().replace(normalized.mergedGraph || { edges: {} });
  getLegacyStore().replace(normalized);
}

function ensureGroup(store, groupId) {
  const gid = normalizeId(groupId);
  if (!gid) return null;
  if (!store.groups[gid]) store.groups[gid] = defaultGroupEntry();
  return store.groups[gid];
}

function pruneLog(log = []) {
  const cutoff = nowMs() - WINDOW_MS;
  const items = normalizeMessageLog(log).filter((item) => item.timestamp >= cutoff);
  if (items.length <= LOG_LIMIT) return items;
  return items.slice(items.length - LOG_LIMIT);
}

function toPairKey(userA = '', userB = '') {
  const first = normalizeId(userA);
  const second = normalizeId(userB);
  if (!first || !second) return '';
  return `${first}->${second}`;
}

function toUndirectedPairKey(userA = '', userB = '') {
  const first = normalizeId(userA);
  const second = normalizeId(userB);
  if (!first || !second) return '';
  return [first, second].sort().join('<->');
}

function isTeaseCue(text = '') {
  return /(哈哈|笑死|又|还在|别装|逮到|偷看|你这|又来|真会|绷不住|拿捏)/i.test(String(text || ''));
}

function isConflictCue(text = '') {
  return /(闭嘴|滚|烦|有病|离谱|神经|别扯|别杠|急了|攻击|吵|怼)/i.test(String(text || ''));
}

function isSupportCue(text = '') {
  return /(对|确实|是的|同意|支持|有道理|没毛病|行|可以)/i.test(String(text || ''));
}

function buildEdge(entry = {}) {
  const edge = normalizeEdge(entry);
  const dominantCandidates = [
    ['conflict', edge.conflictCount],
    ['tease', edge.teaseCount],
    ['support', edge.supportCount],
    ['reply', edge.totalInteractions]
  ].sort((a, b) => b[1] - a[1]);
  edge.dominantType = dominantCandidates[0]?.[1] > 0 ? dominantCandidates[0][0] : '';
  edge.strength = edge.totalInteractions + edge.fastReplyCount + edge.teaseCount + (edge.explicitReplyCount * 2);
  return edge;
}

function summarizeNames(messageLog = [], userA = '', userB = '') {
  const names = new Map();
  for (const item of messageLog) {
    if (item.senderId === userA || item.senderId === userB) {
      if (item.senderName && !names.has(item.senderId)) names.set(item.senderId, item.senderName);
    }
  }
  const first = names.get(userA) || userA;
  const second = names.get(userB) || userB;
  return `${first}<->${second}`;
}

function getOrCreateEdge(directedEdges = {}, fromUserId = '', toUserId = '') {
  const edgeKey = toPairKey(fromUserId, toUserId);
  if (!edgeKey) return null;
  const edge = directedEdges[edgeKey] || defaultEdge();
  edge.fromUserId = normalizeId(fromUserId);
  edge.toUserId = normalizeId(toUserId);
  directedEdges[edgeKey] = edge;
  return edge;
}

function applyInteractionToEdge(edge = null, { groupId = '', timestamp = 0, text = '', isFastReply = false, isExplicitReply = false } = {}) {
  if (!edge) return;
  edge.totalInteractions += 1;
  if (isFastReply) edge.fastReplyCount += 1;
  if (isExplicitReply) edge.explicitReplyCount += 1;
  if (isTeaseCue(text) && !isConflictCue(text)) edge.teaseCount += 1;
  if (isSupportCue(text)) edge.supportCount += 1;
  if (isConflictCue(text)) edge.conflictCount += 1;
  edge.groups[groupId] = (edge.groups[groupId] || 0) + 1;
  edge.lastSeenAt = Math.max(edge.lastSeenAt || 0, Number(timestamp || 0) || 0);
}

function resolveExplicitReplyPair(message = null) {
  const senderId = normalizeId(message?.senderId);
  const replyToSenderId = normalizeId(message?.replyToSenderId);
  if (!senderId || !replyToSenderId || senderId === replyToSenderId) return null;
  return {
    fromUserId: replyToSenderId,
    toUserId: senderId
  };
}

function findPriorHumanMessage(humanMessages = [], currentIndex = -1, targetMessageId = '') {
  const wantedId = normalizeId(targetMessageId);
  if (!wantedId) return null;
  for (let i = Math.min(currentIndex - 1, humanMessages.length - 1); i >= 0; i -= 1) {
    const candidate = humanMessages[i];
    const candidateMessageId = normalizeId(String(candidate?.id || '').replace(/^msg:/, ''));
    if (candidateMessageId && candidateMessageId === wantedId) return candidate;
  }
  return null;
}

function recomputeGroupEntry(groupId, entry = defaultGroupEntry()) {
  const messageLog = pruneLog(entry.messageLog);
  const humanMessages = messageLog.filter((item) => item.kind !== 'bot');
  const distinctUsers = new Set(humanMessages.map((item) => item.senderId)).size;
  const directedEdges = {};
  const initiatorCounts = new Map();

  for (let i = 1; i < humanMessages.length; i += 1) {
    const curr = humanMessages[i];
    const prev = humanMessages[i - 1];
    if (!curr) continue;

    const explicitPair = resolveExplicitReplyPair(curr);
    if (explicitPair) {
      const repliedMessage = findPriorHumanMessage(humanMessages, i, curr.replyToMessageId);
      const delta = repliedMessage ? (curr.timestamp - repliedMessage.timestamp) : (prev ? (curr.timestamp - prev.timestamp) : Number.MAX_SAFE_INTEGER);
      const explicitEdge = getOrCreateEdge(directedEdges, explicitPair.fromUserId, explicitPair.toUserId);
      applyInteractionToEdge(explicitEdge, {
        groupId,
        timestamp: curr.timestamp,
        text: curr.text,
        isFastReply: delta >= 0 && delta <= FAST_REPLY_WINDOW_MS,
        isExplicitReply: true
      });
      directedEdges[toPairKey(explicitPair.fromUserId, explicitPair.toUserId)] = buildEdge(explicitEdge);
      continue;
    }

    if (!prev || prev.senderId === curr.senderId) continue;
    const delta = curr.timestamp - prev.timestamp;
    if (delta < 0 || delta > ACTIVE_PAIR_WINDOW_MS) continue;
    const edge = getOrCreateEdge(directedEdges, prev.senderId, curr.senderId);
    applyInteractionToEdge(edge, {
      groupId,
      timestamp: curr.timestamp,
      text: curr.text,
      isFastReply: delta <= FAST_REPLY_WINDOW_MS,
      isExplicitReply: false
    });
    directedEdges[toPairKey(prev.senderId, curr.senderId)] = buildEdge(edge);
  }

  for (let i = 0; i < humanMessages.length; i += 1) {
    const current = humanMessages[i];
    const responders = new Set();
    for (let j = i + 1; j < humanMessages.length; j += 1) {
      const candidate = humanMessages[j];
      if (candidate.timestamp - current.timestamp > INITIATOR_WINDOW_MS) break;
      if (candidate.senderId !== current.senderId) responders.add(candidate.senderId);
    }
    if (responders.size >= 2) {
      initiatorCounts.set(current.senderId, (initiatorCounts.get(current.senderId) || 0) + 1);
    }
  }

  const undirectedReplyPairs = new Map();
  for (const edge of Object.values(directedEdges)) {
    const pairKey = toUndirectedPairKey(edge.fromUserId, edge.toUserId);
    if (!pairKey) continue;
    const summary = undirectedReplyPairs.get(pairKey) || {
      userA: pairKey.split('<->')[0],
      userB: pairKey.split('<->')[1],
      count: 0,
      strength: 0,
      teaseCount: 0,
      supportCount: 0,
      conflictCount: 0,
      names: summarizeNames(messageLog, pairKey.split('<->')[0], pairKey.split('<->')[1])
    };
    summary.count += edge.totalInteractions;
    summary.strength += edge.strength;
    summary.teaseCount += edge.teaseCount;
    summary.supportCount += edge.supportCount;
    summary.conflictCount += edge.conflictCount;
    undirectedReplyPairs.set(pairKey, summary);
  }

  const topTeasePairs = [...undirectedReplyPairs.values()]
    .filter((item) => item.teaseCount > 0 && item.conflictCount <= Math.max(1, Math.floor(item.teaseCount / 2)))
    .sort((a, b) => b.teaseCount - a.teaseCount)
    .slice(0, 4)
    .map((item) => ({
      userA: item.userA,
      userB: item.userB,
      names: item.names,
      count: item.teaseCount,
      strength: item.strength,
      dominantType: 'tease'
    }));

  const conflictTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.conflictCount, 0);
  const teaseTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.teaseCount, 0);
  const supportTotal = [...undirectedReplyPairs.values()].reduce((sum, item) => sum + item.supportCount, 0);

  let atmosphere = 'cold';
  if (humanMessages.length >= 20 && distinctUsers >= 3) atmosphere = 'noisy';
  if (conflictTotal >= 4 && conflictTotal >= Math.max(2, teaseTotal + supportTotal)) atmosphere = 'tense';
  else if (humanMessages.length >= 16 && teaseTotal + supportTotal >= Math.max(4, conflictTotal * 2)) atmosphere = 'light';
  else if (humanMessages.length < 12 || distinctUsers < 3) atmosphere = 'cold';

  return {
    messageLog,
    summary: normalizeSummary({
      atmosphere,
      sampleCount: humanMessages.length,
      distinctUsers,
      topInitiators: [...initiatorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([userId, count]) => ({
          userId,
          senderName: humanMessages.find((item) => item.senderId === userId)?.senderName || '',
          count
        })),
      topReplyPairs: [...undirectedReplyPairs.values()]
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 4)
        .map((item) => ({
          userA: item.userA,
          userB: item.userB,
          names: item.names,
          count: item.count,
          strength: item.strength,
          dominantType: item.conflictCount > item.teaseCount && item.conflictCount > item.supportCount
            ? 'conflict'
            : (item.teaseCount > item.supportCount ? 'tease' : 'reply')
        })),
      topTeasePairs,
      updatedAt: nowMs()
    }),
    edges: directedEdges
  };
}

function recomputeMergedGraph(groups = {}) {
  const mergedEdges = {};
  for (const [groupId, group] of Object.entries(groups || {})) {
    const rawEdges = group?.edges && typeof group.edges === 'object' ? group.edges : {};
    for (const edge of Object.values(rawEdges)) {
      const key = toPairKey(edge.fromUserId, edge.toUserId);
      if (!key) continue;
      const target = mergedEdges[key] || defaultEdge();
      target.fromUserId = edge.fromUserId;
      target.toUserId = edge.toUserId;
      target.totalInteractions += Number(edge.totalInteractions || 0);
      target.fastReplyCount += Number(edge.fastReplyCount || 0);
      target.explicitReplyCount += Number(edge.explicitReplyCount || 0);
      target.teaseCount += Number(edge.teaseCount || 0);
      target.supportCount += Number(edge.supportCount || 0);
      target.conflictCount += Number(edge.conflictCount || 0);
      target.groups[groupId] = Number(edge.totalInteractions || 0);
      target.lastSeenAt = Math.max(target.lastSeenAt || 0, Number(edge.lastSeenAt || 0) || 0);
      mergedEdges[key] = buildEdge(target);
    }
  }
  return { edges: mergedEdges };
}

function applyGroupDeltaToMergedGraph(mergedGraph = { edges: {} }, groupId = '', previousGroup = defaultGroupEntry(), nextGroup = defaultGroupEntry()) {
  const gid = normalizeId(groupId);
  const nextMerged = {
    edges: {
      ...(mergedGraph?.edges && typeof mergedGraph.edges === 'object' ? mergedGraph.edges : {})
    }
  };

  for (const edge of Object.values(previousGroup?.edges || {})) {
    const key = toPairKey(edge.fromUserId, edge.toUserId);
    if (!key || !nextMerged.edges[key]) continue;
    const target = normalizeEdge(nextMerged.edges[key]);
    target.totalInteractions = Math.max(0, Number(target.totalInteractions || 0) - Number(edge.totalInteractions || 0));
    target.fastReplyCount = Math.max(0, Number(target.fastReplyCount || 0) - Number(edge.fastReplyCount || 0));
    target.explicitReplyCount = Math.max(0, Number(target.explicitReplyCount || 0) - Number(edge.explicitReplyCount || 0));
    target.teaseCount = Math.max(0, Number(target.teaseCount || 0) - Number(edge.teaseCount || 0));
    target.supportCount = Math.max(0, Number(target.supportCount || 0) - Number(edge.supportCount || 0));
    target.conflictCount = Math.max(0, Number(target.conflictCount || 0) - Number(edge.conflictCount || 0));
    delete target.groups[gid];
    if (target.totalInteractions <= 0) {
      delete nextMerged.edges[key];
    } else {
      nextMerged.edges[key] = buildEdge(target);
    }
  }

  for (const edge of Object.values(nextGroup?.edges || {})) {
    const key = toPairKey(edge.fromUserId, edge.toUserId);
    if (!key) continue;
    const target = normalizeEdge(nextMerged.edges[key] || defaultEdge());
    target.fromUserId = edge.fromUserId;
    target.toUserId = edge.toUserId;
    target.totalInteractions += Number(edge.totalInteractions || 0);
    target.fastReplyCount += Number(edge.fastReplyCount || 0);
    target.explicitReplyCount += Number(edge.explicitReplyCount || 0);
    target.teaseCount += Number(edge.teaseCount || 0);
    target.supportCount += Number(edge.supportCount || 0);
    target.conflictCount += Number(edge.conflictCount || 0);
    target.groups[gid] = Number(edge.totalInteractions || 0);
    target.lastSeenAt = Math.max(Number(target.lastSeenAt || 0), Number(edge.lastSeenAt || 0) || 0);
    nextMerged.edges[key] = buildEdge(target);
  }

  return nextMerged;
}

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
