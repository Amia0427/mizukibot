const { createJsonHotStore } = require('./jsonHotStore');

const SCHEMA_VERSION = 'private_message_recovery_v1';

function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    cursorAt: 0,
    pending: {},
    completed: {}
  };
}

function toId(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function messageKey(message = {}) {
  const userId = toId(message.user_id);
  const messageId = toId(message.message_id);
  return userId && messageId ? `${userId}:${messageId}` : '';
}

function isTrackablePrivateMessage(message = {}) {
  if (toId(message.post_type).toLowerCase() !== 'message') return false;
  if (toId(message.message_type).toLowerCase() !== 'private') return false;
  if (!messageKey(message)) return false;
  const selfId = toId(message.self_id);
  return !selfId || toId(message.user_id) !== selfId;
}

function isReplayablePrivateMessage(message = {}) {
  return isTrackablePrivateMessage(message)
    && !/^\s*\//.test(String(message.raw_message || ''));
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    cursorAt: Math.max(0, Number(state.cursorAt) || 0),
    pending: state.pending && typeof state.pending === 'object' ? state.pending : {},
    completed: state.completed && typeof state.completed === 'object' ? state.completed : {}
  };
}

function createPrivateMessageRecoveryStore(options = {}) {
  const filePath = String(options.filePath || '').trim();
  if (!filePath) throw new Error('private message recovery state file is required');

  const now = options.now || Date.now;
  const completedTtlMs = Math.max(60_000, Number(options.completedTtlMs) || 24 * 60 * 60 * 1000);
  const maxCompleted = Math.max(128, Number(options.maxCompleted) || 4096);
  const active = new Set();
  const hotStore = createJsonHotStore(filePath, {
    fallback: createEmptyState,
    deserialize(raw) {
      return normalizeState(JSON.parse(raw));
    }
  });

  function pruneCompleted(state, currentTime) {
    const entries = Object.entries(state.completed)
      .filter(([, completedAt]) => currentTime - Number(completedAt || 0) <= completedTtlMs)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, maxCompleted);
    state.completed = Object.fromEntries(entries);
  }

  function claim(message) {
    if (!isTrackablePrivateMessage(message)) {
      return { tracked: false, accepted: true };
    }

    const key = messageKey(message);
    const state = hotStore.read();
    if (state.completed[key]) return { tracked: true, accepted: false, reason: 'completed', key };
    if (active.has(key)) return { tracked: true, accepted: false, reason: 'active', key };

    const currentTime = now();
    hotStore.update((current) => {
      const existing = current.pending[key] || {};
      current.pending[key] = {
        message,
        receivedAt: Number(existing.receivedAt || currentTime),
        lastAttemptAt: currentTime,
        attempts: Math.max(0, Number(existing.attempts) || 0) + 1
      };
      pruneCompleted(current, currentTime);
    }, { flushNow: true });
    active.add(key);
    return { tracked: true, accepted: true, key };
  }

  function complete(message) {
    const key = messageKey(message);
    if (!key) return false;
    const currentTime = now();
    active.delete(key);
    hotStore.update((state) => {
      delete state.pending[key];
      state.completed[key] = currentTime;
      pruneCompleted(state, currentTime);
    }, { flushNow: true });
    return true;
  }

  function fail(message, error) {
    const key = messageKey(message);
    if (!key) return false;
    active.delete(key);
    hotStore.update((state) => {
      const pending = state.pending[key];
      if (!pending) return;
      pending.lastFailedAt = now();
      pending.lastError = String(error?.message || error || '').slice(0, 500);
    }, { flushNow: true });
    return true;
  }

  function listPending() {
    return Object.values(hotStore.read().pending)
      .map((entry) => entry?.message)
      .filter(Boolean)
      .sort((left, right) => Number(left.time || 0) - Number(right.time || 0));
  }

  function checkpoint(timestamp = now()) {
    hotStore.update((state) => {
      state.cursorAt = Math.max(Number(state.cursorAt || 0), Number(timestamp) || 0);
    }, { flushNow: true });
  }

  function getCursorAt() {
    return Math.max(0, Number(hotStore.read().cursorAt) || 0);
  }

  return {
    checkpoint,
    claim,
    complete,
    fail,
    getCursorAt,
    listPending
  };
}

module.exports = {
  createPrivateMessageRecoveryStore,
  isReplayablePrivateMessage,
  isTrackablePrivateMessage,
  messageKey
};
