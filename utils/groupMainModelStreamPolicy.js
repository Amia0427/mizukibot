const config = require('../config');
const { createJsonHotStore } = require('./jsonHotStore');

const STORE_VERSION = 1;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function defaultEntry() {
  return {
    isPublic: false,
    mainModelStreamEnabled: false,
    updatedAt: 0,
    updatedBy: ''
  };
}

function defaultState() {
  return {
    version: STORE_VERSION,
    groups: {}
  };
}

function normalizeEntry(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    isPublic: raw.isPublic === true,
    mainModelStreamEnabled: raw.isPublic === true && raw.mainModelStreamEnabled === true,
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
    updatedBy: normalizeText(raw.updatedBy)
  };
}

function normalizeState(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const groups = raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)
    ? raw.groups
    : {};
  const normalizedGroups = {};

  for (const [groupId, entry] of Object.entries(groups)) {
    const normalizedGroupId = normalizeText(groupId);
    if (!normalizedGroupId) continue;
    const normalizedEntry = normalizeEntry(entry);
    if (!normalizedEntry.isPublic) continue;
    normalizedGroups[normalizedGroupId] = normalizedEntry;
  }

  return {
    version: STORE_VERSION,
    groups: normalizedGroups
  };
}

const store = createJsonHotStore(config.GROUP_MAIN_MODEL_STREAM_POLICY_FILE, {
  fallback: defaultState,
  debounceMs: 120,
  maxDelayMs: 1000,
  deserialize: (raw, fallback) => normalizeState(
    typeof raw === 'string' && raw.trim()
      ? JSON.parse(raw)
      : (typeof fallback === 'function' ? fallback() : fallback)
  ),
  serialize: (value) => JSON.stringify(normalizeState(value), null, 2)
});

function readState(options = {}) {
  return normalizeState(store.read(options));
}

function writeState(mutator, options = {}) {
  return store.update((current) => {
    const normalizedCurrent = normalizeState(current);
    const mutated = typeof mutator === 'function'
      ? mutator({
          version: normalizedCurrent.version,
          groups: { ...normalizedCurrent.groups }
        })
      : normalizedCurrent;
    return normalizeState(mutated);
  }, options);
}

function getGroupMainModelStreamPolicy(groupId = '') {
  const normalizedGroupId = normalizeText(groupId);
  if (!normalizedGroupId) return defaultEntry();
  const state = readState();
  const entry = state.groups[normalizedGroupId];
  return entry ? normalizeEntry(entry) : defaultEntry();
}

function setGroupPublic(groupId = '', isPublic = false, updatedBy = '', now = Date.now()) {
  const normalizedGroupId = normalizeText(groupId);
  if (!normalizedGroupId) {
    return {
      ok: false,
      reason: 'group_id_required',
      state: defaultEntry()
    };
  }

  const normalizedUpdatedBy = normalizeText(updatedBy);
  const updatedAt = Math.max(0, Number(now || Date.now()) || Date.now());

  const nextState = writeState((current) => {
    const nextGroups = { ...(current.groups || {}) };
    if (isPublic) {
      const existing = normalizeEntry(nextGroups[normalizedGroupId] || {});
      nextGroups[normalizedGroupId] = {
        isPublic: true,
        mainModelStreamEnabled: existing.mainModelStreamEnabled === true,
        updatedAt,
        updatedBy: normalizedUpdatedBy
      };
    } else {
      delete nextGroups[normalizedGroupId];
    }
    return {
      version: STORE_VERSION,
      groups: nextGroups
    };
  });

  return {
    ok: true,
    reason: isPublic ? 'group_public_enabled' : 'group_public_disabled',
    state: normalizeEntry((nextState.groups || {})[normalizedGroupId] || {})
  };
}

function setGroupMainModelStreamEnabled(groupId = '', enabled = false, updatedBy = '', now = Date.now()) {
  const normalizedGroupId = normalizeText(groupId);
  if (!normalizedGroupId) {
    return {
      ok: false,
      reason: 'group_id_required',
      state: defaultEntry()
    };
  }

  const current = getGroupMainModelStreamPolicy(normalizedGroupId);
  if (!current.isPublic) {
    return {
      ok: false,
      reason: 'group_not_public',
      state: current
    };
  }

  const normalizedUpdatedBy = normalizeText(updatedBy);
  const updatedAt = Math.max(0, Number(now || Date.now()) || Date.now());
  const nextState = writeState((storeState) => {
    const nextGroups = { ...(storeState.groups || {}) };
    nextGroups[normalizedGroupId] = {
      isPublic: true,
      mainModelStreamEnabled: enabled === true,
      updatedAt,
      updatedBy: normalizedUpdatedBy
    };
    return {
      version: STORE_VERSION,
      groups: nextGroups
    };
  });

  return {
    ok: true,
    reason: enabled ? 'main_stream_enabled' : 'main_stream_disabled',
    state: normalizeEntry((nextState.groups || {})[normalizedGroupId] || {})
  };
}

function getGroupMainModelStreamStatus(groupId = '') {
  const normalizedGroupId = normalizeText(groupId);
  const policy = getGroupMainModelStreamPolicy(normalizedGroupId);
  const globalAiStreamEnabled = config.AI_STREAM_ENABLED === true;
  const effectivePolicy = globalAiStreamEnabled && policy.isPublic && policy.mainModelStreamEnabled
    ? 'main_model_stream_on'
    : 'main_model_stream_off';

  return {
    groupId: normalizedGroupId,
    isPublic: policy.isPublic,
    mainModelStreamEnabled: policy.mainModelStreamEnabled,
    globalAiStreamEnabled,
    effectivePolicy,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy
  };
}

function formatGroupMainModelStreamStatus(groupId = '') {
  const status = getGroupMainModelStreamStatus(groupId);
  return [
    `groupId: ${status.groupId || '(empty)'}`,
    `public: ${status.isPublic ? 'on' : 'off'}`,
    `main_model_stream: ${status.mainModelStreamEnabled ? 'on' : 'off'}`,
    `global_ai_stream: ${status.globalAiStreamEnabled ? 'on' : 'off'}`,
    `effective_policy: ${status.effectivePolicy}`
  ].join('\n');
}

function shouldForceDisableGroupMainModelStream(options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const groupId = normalizeText(options.groupId || routeMeta.groupId || routeMeta.group_id);
  if (!groupId) return false;
  if (options.isQqGroup !== true) return false;
  if (options.isDirectMainModelReply !== true) return false;

  const policy = getGroupMainModelStreamPolicy(groupId);
  return !(policy.isPublic && policy.mainModelStreamEnabled);
}

function reloadGroupMainModelStreamPolicyStore() {
  store.flushSync();
  store.invalidate();
  return readState({ forceReload: true });
}

module.exports = {
  STORE_VERSION,
  defaultEntry,
  defaultState,
  getGroupMainModelStreamPolicy,
  setGroupPublic,
  setGroupMainModelStreamEnabled,
  getGroupMainModelStreamStatus,
  formatGroupMainModelStreamStatus,
  shouldForceDisableGroupMainModelStream,
  reloadGroupMainModelStreamPolicyStore
};
