const fs = require('fs');
const config = require('../config');
const { createJsonHotStore } = require('./jsonHotStore');

const GROUP_PRESENCE_STATES = new Set([
  'observing',
  'considering',
  'waiting',
  'interjecting',
  'cooling',
  'closed'
]);

const GROUP_PRESENCE_ACTIONS = new Set([
  'no_reply',
  'wait',
  'reply',
  'follow_up',
  'exit'
]);

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[group-awareness] failed to read state:', e.message);
    return fallback;
  }
}

function normalizePresenceState(value, fallback = 'observing') {
  const state = String(value || '').trim();
  return GROUP_PRESENCE_STATES.has(state) ? state : fallback;
}

function normalizePresenceAction(value, fallback = 'no_reply') {
  const action = String(value || '').trim();
  return GROUP_PRESENCE_ACTIONS.has(action) ? action : fallback;
}

function defaultGroupPresence() {
  return {
    state: 'observing',
    last_action: 'no_reply',
    state_updated_at: 0,
    last_inbound_at: 0,
    last_bot_reply_at: 0,
    last_presence_ack_at: 0,
    last_trivial_presence_reply_at: 0,
    last_trivial_presence_reply_text: '',
    human_turns_since_bot_reply: 0,
    waiting_since: 0,
    cooling_until: 0,
    closed_at: 0,
    last_addressee: ''
  };
}

function normalizeGroupPresence(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const fallback = defaultGroupPresence();
  return {
    state: normalizePresenceState(raw.state, fallback.state),
    last_action: normalizePresenceAction(raw.last_action, fallback.last_action),
    state_updated_at: Number(raw.state_updated_at || 0) || 0,
    last_inbound_at: Number(raw.last_inbound_at || 0) || 0,
    last_bot_reply_at: Number(raw.last_bot_reply_at || 0) || 0,
    last_presence_ack_at: Number(raw.last_presence_ack_at || 0) || 0,
    last_trivial_presence_reply_at: Number(raw.last_trivial_presence_reply_at || 0) || 0,
    last_trivial_presence_reply_text: String(raw.last_trivial_presence_reply_text || '').trim(),
    human_turns_since_bot_reply: Math.max(0, Number(raw.human_turns_since_bot_reply || 0) || 0),
    waiting_since: Number(raw.waiting_since || 0) || 0,
    cooling_until: Number(raw.cooling_until || 0) || 0,
    closed_at: Number(raw.closed_at || 0) || 0,
    last_addressee: String(raw.last_addressee || '').trim()
  };
}

function normalizeGroupEntry(entry) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  return {
    recent_messages: Array.isArray(raw.recent_messages) ? raw.recent_messages : [],
    last_awareness_at: Number(raw.last_awareness_at || 0),
    last_reply_at: Number(raw.last_reply_at || 0),
    reply_hour_bucket: String(raw.reply_hour_bucket || ''),
    reply_count_in_hour: Number(raw.reply_count_in_hour || 0),
    presence: normalizeGroupPresence(raw.presence)
  };
}

function normalizeState(state) {
  const raw = state && typeof state === 'object' ? state : {};
  const groups = raw.groups && typeof raw.groups === 'object' ? raw.groups : {};
  const normalizedGroups = {};

  for (const [groupId, entry] of Object.entries(groups)) {
    normalizedGroups[String(groupId)] = normalizeGroupEntry(entry);
  }

  return {
    global_last_awareness_at: Number(raw.global_last_awareness_at || 0),
    groups: normalizedGroups
  };
}

const stateStore = createJsonHotStore(config.GROUP_AWARENESS_STATE_FILE, {
  fallback: () => ({}),
  debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
  maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
});
let state = normalizeState(stateStore.read({ forceReload: true }));

function scheduleFlush() {
  try {
    stateStore.replace(state);
  } catch (e) {
    console.error('[group-awareness] failed to flush state:', e.message);
  }
}

function flushAllSync() {
  try {
    stateStore.replace(state, { flushNow: true });
  } catch (e) {
    console.error('[group-awareness] failed to flush on exit:', e.message);
  }
}

const GROUP_AWARENESS_PROCESS_HOOK_KEY = '__mizuki_group_awareness_flush_hooks_registered__';
if (!process[GROUP_AWARENESS_PROCESS_HOOK_KEY]) {
  process[GROUP_AWARENESS_PROCESS_HOOK_KEY] = true;
  process.on('exit', flushAllSync);
  if (!process.listeners('SIGINT').includes(flushAllSync)) process.on('SIGINT', flushAllSync);
  if (!process.listeners('SIGTERM').includes(flushAllSync)) process.on('SIGTERM', flushAllSync);
}

function ensureGroupState(groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) {
    return normalizeGroupEntry({});
  }

  if (!state.groups[gid]) {
    state.groups[gid] = normalizeGroupEntry({});
  } else {
    state.groups[gid] = normalizeGroupEntry(state.groups[gid]);
  }

  return state.groups[gid];
}

function getHourBucket(ts = Date.now()) {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}`;
}

function appendGroupMessage(groupId, message, maxSize = 20) {
  const group = ensureGroupState(groupId);
  const limit = Math.max(5, Math.min(100, Number(maxSize) || 20));
  const entry = message && typeof message === 'object' ? message : {};
  group.recent_messages.push({
    sender_id: String(entry.sender_id || ''),
    sender_name: String(entry.sender_name || ''),
    message_id: String(entry.message_id || entry.id || '').trim(),
    text: String(entry.text || '').trim(),
    timestamp: Number(entry.timestamp || Date.now())
  });

  group.recent_messages.sort((a, b) => {
    const tsDiff = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    if (tsDiff !== 0) return tsDiff;
    return String(a?.message_id || '').localeCompare(String(b?.message_id || ''));
  });

  if (group.recent_messages.length > limit) {
    group.recent_messages.splice(0, group.recent_messages.length - limit);
  }
  scheduleFlush();
  return group.recent_messages;
}

function getRecentMessages(groupId) {
  return ensureGroupState(groupId).recent_messages.slice();
}

function getGroupPresence(groupId) {
  return { ...ensureGroupState(groupId).presence };
}

function updateGroupPresence(groupId, updater) {
  const group = ensureGroupState(groupId);
  const current = normalizeGroupPresence(group.presence);
  const next = typeof updater === 'function'
    ? updater({ ...current })
    : { ...current, ...(updater && typeof updater === 'object' ? updater : {}) };

  group.presence = normalizeGroupPresence(next);
  scheduleFlush();
  return { ...group.presence };
}

function getLastAwarenessAt(groupId) {
  return Number(ensureGroupState(groupId).last_awareness_at || 0);
}

function setLastAwarenessAt(groupId, timestamp = Date.now()) {
  const group = ensureGroupState(groupId);
  group.last_awareness_at = Number(timestamp || Date.now());
  state.global_last_awareness_at = group.last_awareness_at;
  scheduleFlush();
  return group.last_awareness_at;
}

function getGlobalLastAwarenessAt() {
  return Number(state.global_last_awareness_at || 0);
}

function getLastReplyAt(groupId) {
  return Number(ensureGroupState(groupId).last_reply_at || 0);
}

function canReplyInHour(groupId, now = Date.now(), maxPerHour = 3) {
  const group = ensureGroupState(groupId);
  const bucket = getHourBucket(now);
  if (group.reply_hour_bucket !== bucket) {
    group.reply_hour_bucket = bucket;
    group.reply_count_in_hour = 0;
    scheduleFlush();
  }

  const limit = Math.max(1, Number(maxPerHour) || 3);
  return Number(group.reply_count_in_hour || 0) < limit;
}

function recordReply(groupId, now = Date.now()) {
  const group = ensureGroupState(groupId);
  const bucket = getHourBucket(now);
  if (group.reply_hour_bucket !== bucket) {
    group.reply_hour_bucket = bucket;
    group.reply_count_in_hour = 0;
  }

  group.last_reply_at = Number(now || Date.now());
  group.reply_count_in_hour = Number(group.reply_count_in_hour || 0) + 1;
  scheduleFlush();
  return {
    last_reply_at: group.last_reply_at,
    reply_count_in_hour: group.reply_count_in_hour,
    reply_hour_bucket: group.reply_hour_bucket
  };
}

module.exports = {
  appendGroupMessage,
  getRecentMessages,
  defaultGroupPresence,
  normalizeGroupPresence,
  getGroupPresence,
  updateGroupPresence,
  getLastAwarenessAt,
  setLastAwarenessAt,
  getGlobalLastAwarenessAt,
  getLastReplyAt,
  canReplyInHour,
  recordReply,
  ensureGroupState,
  getHourBucket
};
