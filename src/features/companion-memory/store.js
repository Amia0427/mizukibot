const { createJsonHotStore } = require('../../../utils/jsonHotStore');

const STATE_VERSION = 1;

function normalizeText(value) {
  return String(value || '').trim();
}

function defaultState() {
  return { version: STATE_VERSION, users: {} };
}

function normalizeState(value = {}) {
  const users = value.users && typeof value.users === 'object' && !Array.isArray(value.users)
    ? value.users
    : {};
  return {
    version: STATE_VERSION,
    users: Object.fromEntries(Object.entries(users).map(([userId, settings]) => [
      normalizeText(userId),
      { autoMemoryEnabled: settings?.autoMemoryEnabled !== false }
    ]).filter(([userId]) => userId))
  };
}

function createCompanionMemorySettingsStore(filePath, options = {}) {
  const hotStore = options.hotStore || createJsonHotStore(filePath, {
    fallback: defaultState,
    deserialize: (raw) => normalizeState(JSON.parse(raw))
  });

  function isAutoMemoryEnabled(userId) {
    const id = normalizeText(userId);
    if (!id) return true;
    return normalizeState(hotStore.read()).users[id]?.autoMemoryEnabled !== false;
  }

  function setAutoMemoryEnabled(userId, enabled) {
    const id = normalizeText(userId);
    if (!id) throw new Error('companion memory requires a private userId');
    hotStore.update((state) => {
      const next = normalizeState(state);
      next.users[id] = { autoMemoryEnabled: enabled !== false };
      return next;
    }, { flushNow: true });
    return enabled !== false;
  }

  return {
    isAutoMemoryEnabled,
    setAutoMemoryEnabled
  };
}

module.exports = {
  STATE_VERSION,
  createCompanionMemorySettingsStore,
  defaultState,
  normalizeState
};
