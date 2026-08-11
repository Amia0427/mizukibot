const { createJsonHotStore } = require('../../../utils/jsonHotStore');
const { HOLIDAY_CATALOG, normalizeAnniversary } = require('./calendar');

const STATE_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    users: {},
    deliveries: {},
    runtime: { lastScanAt: 0, nextScanAt: 0, lastError: '' }
  };
}

function defaultUser(now = Date.now()) {
  return {
    status: 'pending',
    email: '',
    displayName: '',
    verificationCode: '',
    verificationExpiresAt: 0,
    disabledHolidayIds: [],
    anniversaries: [],
    createdAt: now,
    updatedAt: now
  };
}

function normalizeUser(value = {}, now = Date.now()) {
  const defaultHolidayIds = new Set(HOLIDAY_CATALOG.map((item) => item.id));
  const disabledHolidayIds = Array.isArray(value.disabledHolidayIds)
    ? [...new Set(value.disabledHolidayIds.map((item) => String(item || '').trim()).filter((item) => defaultHolidayIds.has(item)))]
    : [];
  const anniversaries = Array.isArray(value.anniversaries)
    ? value.anniversaries.map(normalizeAnniversary).filter(Boolean).map((item) => ({ ...item }))
    : [];
  return {
    ...defaultUser(now),
    status: ['pending', 'active', 'inactive'].includes(value.status) ? value.status : 'pending',
    email: String(value.email || '').trim(),
    displayName: String(value.displayName || '').trim(),
    verificationCode: String(value.verificationCode || '').trim(),
    verificationExpiresAt: Number(value.verificationExpiresAt || 0) || 0,
    disabledHolidayIds,
    anniversaries,
    createdAt: Number(value.createdAt || now) || now,
    updatedAt: Number(value.updatedAt || now) || now
  };
}

function normalizeDelivery(value = {}) {
  const events = Array.isArray(value.events)
    ? value.events.map((event) => ({
      id: String(event?.id || '').trim(),
      name: String(event?.name || '').trim(),
      kind: String(event?.kind || '').trim(),
      date: String(event?.date || '').trim()
    })).filter((event) => event.id && event.name)
    : [];
  return {
    status: ['pending', 'retry_wait', 'sent', 'retry_exhausted'].includes(value.status)
      ? value.status
      : 'pending',
    events,
    content: value.content && typeof value.content === 'object'
      ? {
        subject: String(value.content.subject || '').trim(),
        greeting: String(value.content.greeting || '').trim(),
        body: String(value.content.body || '').trim(),
        closing: String(value.content.closing || '').trim()
      }
      : null,
    attempts: Math.max(0, Number(value.attempts || 0) || 0),
    nextAttemptAt: Number(value.nextAttemptAt || 0) || 0,
    lastAttemptAt: Number(value.lastAttemptAt || 0) || 0,
    sentAt: Number(value.sentAt || 0) || 0,
    lastError: String(value.lastError || '').trim(),
    createdAt: Number(value.createdAt || 0) || 0,
    updatedAt: Number(value.updatedAt || 0) || 0
  };
}

function normalizeState(value = {}, now = Date.now()) {
  const normalized = defaultState();
  const users = value.users && typeof value.users === 'object' ? value.users : {};
  for (const [userId, user] of Object.entries(users)) {
    if (String(userId || '').trim()) normalized.users[userId] = normalizeUser(user, now);
  }
  const deliveries = value.deliveries && typeof value.deliveries === 'object' ? value.deliveries : {};
  for (const [userId, entries] of Object.entries(deliveries)) {
    if (!entries || typeof entries !== 'object') continue;
    normalized.deliveries[userId] = {};
    for (const [dateKey, delivery] of Object.entries(entries)) {
      normalized.deliveries[userId][dateKey] = normalizeDelivery(delivery);
    }
  }
  if (value.runtime && typeof value.runtime === 'object') {
    normalized.runtime = { ...normalized.runtime, ...value.runtime };
  }
  return normalized;
}

function createEmailGreetingStateStore(filePath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const hotStore = options.hotStore || createJsonHotStore(filePath, {
    fallback: defaultState,
    deserialize(raw) {
      return normalizeState(JSON.parse(raw), now());
    }
  });

  function getUser(userId) {
    const id = String(userId || '').trim();
    return clone(hotStore.read().users[id] || defaultUser(now()));
  }

  function updateUser(userId, mutator, updateOptions = {}) {
    const id = String(userId || '').trim();
    if (!id) throw new Error('userId is required');
    let result;
    hotStore.update((state) => {
      state.users[id] = normalizeUser(state.users[id], now());
      result = mutator(state.users[id]);
      state.users[id].updatedAt = now();
      return state;
    }, updateOptions);
    return result === undefined ? getUser(id) : result;
  }

  function getDelivery(userId, dateKey) {
    const id = String(userId || '').trim();
    const date = String(dateKey || '').trim();
    return clone(hotStore.read().deliveries?.[id]?.[date] || null);
  }

  function updateDelivery(userId, dateKey, mutator, updateOptions = {}) {
    const id = String(userId || '').trim();
    const date = String(dateKey || '').trim();
    if (!id || !date) throw new Error('userId and dateKey are required');
    let result;
    hotStore.update((state) => {
      if (!state.deliveries[id]) state.deliveries[id] = {};
      state.deliveries[id][date] = normalizeDelivery(state.deliveries[id][date]);
      result = mutator(state.deliveries[id][date]);
      state.deliveries[id][date].updatedAt = now();
      return state;
    }, updateOptions);
    return result === undefined ? getDelivery(id, date) : result;
  }

  return {
    flush: () => hotStore.flushSync(),
    getDelivery,
    getUser,
    listActiveUserIds: () => Object.entries(hotStore.read().users)
      .filter(([, user]) => user.status === 'active' && user.email)
      .map(([userId]) => userId),
    listUserIds: () => Object.keys(hotStore.read().users),
    read: () => clone(hotStore.read()),
    updateDelivery,
    updateRuntime: (mutator, updateOptions = {}) => hotStore.update((state) => {
      mutator(state.runtime);
      return state;
    }, updateOptions),
    updateUser
  };
}

module.exports = {
  STATE_VERSION,
  createEmailGreetingStateStore,
  defaultState,
  defaultUser,
  normalizeState,
  normalizeUser,
  normalizeDelivery
};
