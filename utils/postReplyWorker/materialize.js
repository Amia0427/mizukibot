const config = require('../../config');

const materializeDebounceState = {
  timer: null,
  promise: null,
  pendingCount: 0,
  lastScheduledAt: 0,
  dirtyScopes: {
    userIds: new Set(),
    sessionKeys: new Set(),
    groupIds: new Set()
  }
};

function getMemoryV3Module() {
  return require('../memory-v3');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function getPostReplyMaterializeDelayMs(options = {}) {
  if (options.force === true) return 0;
  const configured = Number(options.delayMs ?? config.POST_REPLY_MATERIALIZE_DEBOUNCE_MS);
  return Math.max(1000, Number.isFinite(configured) && configured > 0 ? configured : 45 * 1000);
}

function addPostReplyDirtyScope(options = {}) {
  const add = (set, value) => {
    const text = normalizeText(value);
    if (text) set.add(text);
  };
  add(materializeDebounceState.dirtyScopes.userIds, options.userId);
  add(materializeDebounceState.dirtyScopes.sessionKeys, options.sessionKey);
  add(materializeDebounceState.dirtyScopes.groupIds, options.groupId);
}

function consumePostReplyDirtyScopes() {
  const scopes = {
    userIds: Array.from(materializeDebounceState.dirtyScopes.userIds),
    sessionKeys: Array.from(materializeDebounceState.dirtyScopes.sessionKeys),
    groupIds: Array.from(materializeDebounceState.dirtyScopes.groupIds)
  };
  materializeDebounceState.dirtyScopes.userIds.clear();
  materializeDebounceState.dirtyScopes.sessionKeys.clear();
  materializeDebounceState.dirtyScopes.groupIds.clear();
  return scopes;
}

function schedulePostReplyMaterialize(options = {}) {
  const { materializeMemoryViews } = getMemoryV3Module();
  if (options.force === true) {
    return Promise.resolve(materializeMemoryViews({
      ...options,
      force: true,
      source: options.source || 'post_reply_force'
    }));
  }

  addPostReplyDirtyScope(options);
  materializeDebounceState.pendingCount += 1;
  if (materializeDebounceState.timer) {
    return {
      scheduled: true,
      coalesced: true,
      pendingCount: materializeDebounceState.pendingCount,
      delayMs: getPostReplyMaterializeDelayMs(options)
    };
  }

  const delayMs = getPostReplyMaterializeDelayMs(options);
  materializeDebounceState.lastScheduledAt = Date.now();
  materializeDebounceState.timer = setTimeout(() => {
    const pendingCount = materializeDebounceState.pendingCount;
    const dirtyScopes = consumePostReplyDirtyScopes();
    materializeDebounceState.timer = null;
    materializeDebounceState.pendingCount = 0;
    materializeDebounceState.promise = Promise.resolve()
      .then(() => materializeMemoryViews({
        source: 'post_reply_debounced',
        pendingCount,
        mode: 'incremental',
        dirtyScopes
      }))
      .catch((error) => {
        console.warn('[post_reply_worker] debounced materialize failed:', error?.message || error);
      })
      .finally(() => {
        materializeDebounceState.promise = null;
      });
  }, delayMs);
  if (typeof materializeDebounceState.timer.unref === 'function') {
    materializeDebounceState.timer.unref();
  }
  return {
    scheduled: true,
    coalesced: false,
    pendingCount: materializeDebounceState.pendingCount,
    delayMs
  };
}

async function flushPostReplyMaterialize(options = {}) {
  const { materializeMemoryViews } = getMemoryV3Module();
  if (materializeDebounceState.timer) {
    clearTimeout(materializeDebounceState.timer);
    materializeDebounceState.timer = null;
    const pendingCount = materializeDebounceState.pendingCount;
    const dirtyScopes = consumePostReplyDirtyScopes();
    materializeDebounceState.pendingCount = 0;
    materializeDebounceState.promise = Promise.resolve(materializeMemoryViews({
      source: options.source || 'post_reply_flush',
      pendingCount,
      force: options.force === true,
      mode: options.force === true ? 'full' : 'incremental',
      dirtyScopes
    })).finally(() => {
      materializeDebounceState.promise = null;
    });
  }
  if (materializeDebounceState.promise) {
    await materializeDebounceState.promise;
  }
  return {
    flushed: true,
    pendingCount: materializeDebounceState.pendingCount
  };
}

module.exports = {
  flushPostReplyMaterialize,
  schedulePostReplyMaterialize
};
