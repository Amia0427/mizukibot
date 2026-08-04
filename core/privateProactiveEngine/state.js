const fs = require('fs');
const { createJsonHotStore } = require('../../utils/jsonHotStore');
const { getLocalClock } = require('./config');

const SCHEMA_VERSION = 1;

function defaultRootState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    budget: { day: '', used: 0 },
    runtime: {
      startedAt: 0,
      stoppedAt: 0,
      lastScanAt: 0,
      nextScanAt: 0,
      lastResult: null
    },
    users: {}
  };
}

function defaultUserState(now = 0) {
  return {
    registeredAt: Math.max(0, Number(now) || 0),
    enabled: true,
    enabledAt: Math.max(0, Number(now) || 0),
    autoPaused: false,
    activityVersion: 1,
    lastActivityAt: Math.max(0, Number(now) || 0),
    lastActivitySource: 'private_registration',
    lastPrivateActivityAt: Math.max(0, Number(now) || 0),
    lastProactiveSentAt: 0,
    unansweredBatches: 0,
    cursor: { day: '', consumedWindowKeys: [] },
    daily: { day: '', batchesSent: 0 },
    signatures: [],
    narratives: [],
    firstNotice: {
      status: 'pending',
      attemptedAt: 0,
      sentAt: 0
    },
    inFlight: null
  };
}

function normalizeSignature(item = {}) {
  const hash = String(item.hash || '').trim();
  const at = Math.max(0, Number(item.at || 0) || 0);
  return hash && at ? { hash, at } : null;
}

function normalizeNarrative(item = {}) {
  const messages = (Array.isArray(item.messages) ? item.messages : [])
    .map((message) => String(message || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  if (messages.length === 0) return null;
  return {
    at: Math.max(0, Number(item.at || 0) || 0),
    messages
  };
}

function normalizeUserState(raw = {}) {
  const base = defaultUserState(raw.registeredAt);
  const firstNotice = raw.firstNotice && typeof raw.firstNotice === 'object' ? raw.firstNotice : {};
  const cursor = raw.cursor && typeof raw.cursor === 'object' ? raw.cursor : {};
  const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
  return {
    ...base,
    registeredAt: Math.max(0, Number(raw.registeredAt || 0) || 0),
    enabled: raw.enabled !== false,
    enabledAt: Math.max(0, Number(raw.enabledAt || 0) || 0),
    autoPaused: raw.autoPaused === true,
    activityVersion: Math.max(0, Number(raw.activityVersion || 0) || 0),
    lastActivityAt: Math.max(0, Number(raw.lastActivityAt || 0) || 0),
    lastActivitySource: String(raw.lastActivitySource || '').trim(),
    lastPrivateActivityAt: Math.max(0, Number(raw.lastPrivateActivityAt || 0) || 0),
    lastProactiveSentAt: Math.max(0, Number(raw.lastProactiveSentAt || 0) || 0),
    unansweredBatches: Math.max(0, Math.floor(Number(raw.unansweredBatches || 0) || 0)),
    cursor: {
      day: String(cursor.day || '').trim(),
      consumedWindowKeys: Array.from(new Set(
        (Array.isArray(cursor.consumedWindowKeys) ? cursor.consumedWindowKeys : [])
          .map((key) => String(key || '').trim())
          .filter(Boolean)
      ))
    },
    daily: {
      day: String(daily.day || '').trim(),
      batchesSent: Math.max(0, Math.floor(Number(daily.batchesSent || 0) || 0))
    },
    signatures: (Array.isArray(raw.signatures) ? raw.signatures : [])
      .map(normalizeSignature)
      .filter(Boolean)
      .slice(-100),
    narratives: (Array.isArray(raw.narratives) ? raw.narratives : [])
      .map(normalizeNarrative)
      .filter(Boolean)
      .slice(-12),
    firstNotice: {
      status: String(firstNotice.status || 'pending').trim() || 'pending',
      attemptedAt: Math.max(0, Number(firstNotice.attemptedAt || 0) || 0),
      sentAt: Math.max(0, Number(firstNotice.sentAt || 0) || 0)
    },
    inFlight: raw.inFlight && typeof raw.inFlight === 'object' ? { ...raw.inFlight } : null
  };
}

function normalizeRootState(raw = {}) {
  const base = defaultRootState();
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  const runtime = raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {};
  const users = {};
  for (const [userId, value] of Object.entries(raw.users && typeof raw.users === 'object' ? raw.users : {})) {
    const id = String(userId || '').trim();
    if (id) users[id] = normalizeUserState(value);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    budget: {
      day: String(budget.day || '').trim(),
      used: Math.max(0, Math.floor(Number(budget.used || 0) || 0))
    },
    runtime: {
      ...base.runtime,
      startedAt: Math.max(0, Number(runtime.startedAt || 0) || 0),
      stoppedAt: Math.max(0, Number(runtime.stoppedAt || 0) || 0),
      lastScanAt: Math.max(0, Number(runtime.lastScanAt || 0) || 0),
      nextScanAt: Math.max(0, Number(runtime.nextScanAt || 0) || 0),
      lastResult: runtime.lastResult && typeof runtime.lastResult === 'object'
        ? { ...runtime.lastResult }
        : null
    },
    users
  };
}

function recoverInterruptedState(state, now) {
  let recovered = false;
  for (const [userId, user] of Object.entries(state.users)) {
    if (user.inFlight) {
      state.runtime.lastResult = {
        at: now,
        userId,
        status: 'interrupted',
        reason: 'process_restarted_with_inflight_attempt'
      };
      user.inFlight = null;
      recovered = true;
    }
    if (user.firstNotice.status === 'generating') {
      user.firstNotice.status = 'pending';
      recovered = true;
    } else if (user.firstNotice.status === 'sending') {
      user.firstNotice.status = 'sent_unknown';
      recovered = true;
    }
  }
  return recovered;
}

function createPrivateProactiveStateStore(filePath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const store = createJsonHotStore(filePath, {
    fallback: defaultRootState,
    deserialize(raw) {
      return normalizeRootState(JSON.parse(raw));
    }
  });
  const current = store.read();
  if (recoverInterruptedState(current, now())) {
    store.replace(current, { flushNow: true });
  }
  return store;
}

function safeReadState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return defaultRootState();
    return normalizeRootState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return defaultRootState();
  }
}

function buildPrivateProactiveStatus(runtimeConfig = {}, options = {}) {
  const privateConfig = options.privateConfig || require('./config').resolvePrivateProactiveConfig(runtimeConfig, options);
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const day = getLocalClock(now, privateConfig.timezone).day;
  const state = safeReadState(privateConfig.stateFile);
  const users = Object.values(state.users).filter((user) => user.registeredAt > 0);
  const budgetUsed = state.budget.day === day ? state.budget.used : 0;
  return {
    enabled: privateConfig.enabled,
    stateFile: privateConfig.stateFile,
    registeredCount: users.length,
    enabledCount: users.filter((user) => user.enabled && !user.autoPaused).length,
    pausedCount: users.filter((user) => user.enabled && user.autoPaused).length,
    disabledCount: users.filter((user) => !user.enabled).length,
    budget: {
      day,
      used: budgetUsed,
      limit: privateConfig.globalModelDailyLimit,
      remaining: Math.max(0, privateConfig.globalModelDailyLimit - budgetUsed)
    },
    nextScanAt: state.runtime.nextScanAt,
    lastScanAt: state.runtime.lastScanAt,
    lastResult: state.runtime.lastResult
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildPrivateProactiveStatus,
  createPrivateProactiveStateStore,
  defaultRootState,
  defaultUserState,
  normalizeRootState,
  normalizeUserState,
  safeReadState
};
