const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');

const DEFAULT_INDEX = Object.freeze({
  version: 1,
  users: {}
});

function nowTs() {
  return Date.now();
}

function sanitizeText(value) {
  return String(value || '').trim();
}

function sanitizeScopeId(value) {
  const text = sanitizeText(value);
  if (!text) return '';
  return text.replace(/[^\w:-]/g, '').slice(0, 120);
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error('[memory_scope_index] failed to read json:', filePath, error.message);
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  getJsonStore(filePath, {
    fallback: () => DEFAULT_INDEX
  }).replace(data, { flushNow: true });
}

function normalizeEntryList(items = [], key) {
  const maxItems = Math.max(1, Number(config.MEMORY_CLI_GROUP_HISTORY_MAX) || 50);
  const list = [];
  const seen = new Set();

  for (const raw of Array.isArray(items) ? items : []) {
    const id = sanitizeScopeId(raw?.[key]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({
      [key]: id,
      lastSeenAt: Math.max(0, Number(raw?.lastSeenAt || raw?.last_seen_at || 0) || 0)
    });
  }

  list.sort((a, b) => (Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)));
  return list.slice(0, maxItems);
}

function normalizeIndex(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const users = input.users && typeof input.users === 'object' ? input.users : {};
  const next = {
    version: 1,
    users: {}
  };

  for (const [userId, value] of Object.entries(users)) {
    const uid = sanitizeScopeId(userId);
    if (!uid || !value || typeof value !== 'object') continue;

    next.users[uid] = {
      updatedAt: Math.max(0, Number(value.updatedAt || value.updated_at || 0) || 0),
      groups: normalizeEntryList(value.groups, 'groupId'),
      channels: normalizeEntryList(value.channels, 'channelId')
    };
  }

  return next;
}

function loadMemoryScopeIndex() {
  return normalizeIndex(safeReadJson(config.MEMORY_SCOPE_INDEX_FILE, DEFAULT_INDEX));
}

function saveMemoryScopeIndex(index) {
  const normalized = normalizeIndex(index);
  atomicWriteJson(config.MEMORY_SCOPE_INDEX_FILE, normalized);
  return normalized;
}

function upsertScopeListEntry(items = [], key, id) {
  const target = sanitizeScopeId(id);
  if (!target) return normalizeEntryList(items, key);

  const next = [];
  let found = false;
  for (const row of Array.isArray(items) ? items : []) {
    const current = sanitizeScopeId(row?.[key]);
    if (!current) continue;
    if (current === target) {
      next.push({
        [key]: target,
        lastSeenAt: nowTs()
      });
      found = true;
      continue;
    }
    next.push({
      [key]: current,
      lastSeenAt: Math.max(0, Number(row?.lastSeenAt || 0) || 0)
    });
  }

  if (!found) {
    next.push({
      [key]: target,
      lastSeenAt: nowTs()
    });
  }

  return normalizeEntryList(next, key);
}

function recordMemoryScope(userId, routeMeta = {}) {
  const uid = sanitizeScopeId(userId);
  if (!uid) return { recorded: false, userId: '', groups: [], channels: [] };

  const groupId = sanitizeScopeId(routeMeta.groupId || routeMeta.group_id);
  const channelId = sanitizeScopeId(routeMeta.channelId || routeMeta.channel_id);
  if (!groupId && !channelId) {
    return { recorded: false, userId: uid, groups: [], channels: [] };
  }

  const index = loadMemoryScopeIndex();
  const previous = index.users[uid] && typeof index.users[uid] === 'object'
    ? index.users[uid]
    : { updatedAt: 0, groups: [], channels: [] };

  const next = {
    updatedAt: nowTs(),
    groups: groupId ? upsertScopeListEntry(previous.groups, 'groupId', groupId) : normalizeEntryList(previous.groups, 'groupId'),
    channels: channelId ? upsertScopeListEntry(previous.channels, 'channelId', channelId) : normalizeEntryList(previous.channels, 'channelId')
  };

  index.users[uid] = next;
  saveMemoryScopeIndex(index);
  return {
    recorded: true,
    userId: uid,
    groups: next.groups,
    channels: next.channels
  };
}

function getMemoryScopeForUser(userId) {
  const uid = sanitizeScopeId(userId);
  const index = loadMemoryScopeIndex();
  const entry = index.users[uid] && typeof index.users[uid] === 'object'
    ? index.users[uid]
    : { updatedAt: 0, groups: [], channels: [] };
  return {
    userId: uid,
    updatedAt: Math.max(0, Number(entry.updatedAt || 0) || 0),
    groups: normalizeEntryList(entry.groups, 'groupId'),
    channels: normalizeEntryList(entry.channels, 'channelId')
  };
}

function getAccessibleGroupIdsForUser(userId) {
  return getMemoryScopeForUser(userId).groups.map((item) => item.groupId).filter(Boolean);
}

function getAccessibleChannelIdsForUser(userId) {
  return getMemoryScopeForUser(userId).channels.map((item) => item.channelId).filter(Boolean);
}

module.exports = {
  loadMemoryScopeIndex,
  saveMemoryScopeIndex,
  recordMemoryScope,
  getMemoryScopeForUser,
  getAccessibleGroupIdsForUser,
  getAccessibleChannelIdsForUser
};
