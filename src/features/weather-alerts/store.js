const { createJsonHotStore } = require('../../../utils/jsonHotStore');

const STATE_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    principals: {},
    runtime: { lastScanAt: 0, nextScanAt: 0, lastError: '' }
  };
}

function defaultPrincipal(now = Date.now()) {
  return {
    paused: false,
    subscriptions: [],
    alerts: {},
    createdAt: now,
    updatedAt: now
  };
}

function normalizePrincipal(value = {}, now = Date.now()) {
  return {
    paused: value.paused === true,
    subscriptions: Array.isArray(value.subscriptions)
      ? value.subscriptions.filter((item) => item?.locationId).map((item) => ({ ...item }))
      : [],
    alerts: value.alerts && typeof value.alerts === 'object' && !Array.isArray(value.alerts)
      ? { ...value.alerts }
      : {},
    createdAt: Number(value.createdAt || now) || now,
    updatedAt: Number(value.updatedAt || now) || now
  };
}

function normalizeState(value = {}, now = Date.now()) {
  const normalized = defaultState();
  const principals = value.principals && typeof value.principals === 'object' ? value.principals : {};
  for (const [principalId, principal] of Object.entries(principals)) {
    if (!String(principalId || '').trim()) continue;
    normalized.principals[principalId] = normalizePrincipal(principal, now);
  }
  if (value.runtime && typeof value.runtime === 'object') normalized.runtime = { ...normalized.runtime, ...value.runtime };
  return normalized;
}

function createWeatherAlertStateStore(filePath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const hotStore = options.hotStore || createJsonHotStore(filePath, {
    fallback: defaultState,
    deserialize(raw) {
      return normalizeState(JSON.parse(raw), now());
    }
  });

  function getPrincipal(principalId) {
    const id = String(principalId || '').trim();
    const principal = hotStore.read().principals[id];
    return clone(principal || defaultPrincipal(now()));
  }

  function updatePrincipal(principalId, mutator, updateOptions = {}) {
    const id = String(principalId || '').trim();
    if (!id) throw new Error('principalId is required');
    let result;
    hotStore.update((state) => {
      state.principals[id] = normalizePrincipal(state.principals[id], now());
      result = mutator(state.principals[id]);
      state.principals[id].updatedAt = now();
      return state;
    }, updateOptions);
    return result === undefined ? getPrincipal(id) : result;
  }

  function updateRuntime(mutator, updateOptions = {}) {
    hotStore.update((state) => {
      mutator(state.runtime);
      return state;
    }, updateOptions);
  }

  return {
    flush: () => hotStore.flushSync(),
    getPrincipal,
    listPrincipalIds: () => Object.keys(hotStore.read().principals),
    read: () => clone(hotStore.read()),
    updatePrincipal,
    updateRuntime
  };
}

module.exports = {
  STATE_VERSION,
  createWeatherAlertStateStore,
  defaultPrincipal,
  defaultState,
  normalizeState
};
