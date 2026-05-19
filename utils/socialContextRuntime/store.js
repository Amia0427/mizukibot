const path = require('path');
const config = require('../../config');
const { createJsonHotStore } = require('../jsonHotStore');

const STORE_FILE = String(config.SOCIAL_CONTEXT_STORE_FILE || path.join(config.DATA_DIR, 'social_context.json')).trim();
const SOCIAL_STORE_DIR = path.join(path.dirname(STORE_FILE), 'social');
const SOCIAL_GROUP_DIR = path.join(SOCIAL_STORE_DIR, 'group');
const SOCIAL_MERGED_FILE = path.join(SOCIAL_STORE_DIR, 'merged_graph.json');

const socialStores = {
  legacy: null,
  merged: null,
  groups: new Map()
};

function nowMs() {
  return Date.now();
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

function readStore() {
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

module.exports = {
  STORE_FILE,
  defaultEdge,
  defaultGroupEntry,
  defaultSummary,
  defaultStore,
  ensureGroup,
  normalizeArray,
  normalizeEdge,
  normalizeId,
  normalizeMessage,
  normalizeMessageLog,
  normalizeStore,
  normalizeSummary,
  normalizeText,
  nowMs,
  readStore,
  writeStore
};
