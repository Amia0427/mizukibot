const config = require('../../config');

const TEMPLATE_DEFAULTS = Object.freeze({
  resident: {
    activationMode: 'resident',
    durationTurns: 0,
    durationMs: 0,
    probability: 1
  },
  scene: {
    activationMode: 'session',
    durationTurns: 3,
    durationMs: 5 * 60 * 1000,
    probability: 1
  },
  event: {
    activationMode: 'session',
    durationTurns: 3,
    durationMs: 15 * 60 * 1000,
    probability: 1
  },
  tone_example: {
    activationMode: 'session',
    durationTurns: 1,
    durationMs: 3 * 60 * 1000,
    probability: 1
  }
});

const stateBySession = new Map();

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getSessionKey(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  return normalizeText(
    context.sessionKey
    || context.sessionId
    || routeMeta.sessionKey
    || routeMeta.session_key
    || routeMeta.sessionId
    || routeMeta.session_id
  );
}

function normalizeScopeContext(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  return {
    sessionKey: getSessionKey(context),
    userId: normalizeText(context.userId || context.senderId || routeMeta.userId || routeMeta.user_id || routeMeta.senderId || routeMeta.sender_id),
    groupId: normalizeText(context.groupId || routeMeta.groupId || routeMeta.group_id),
    isAdmin: context.isAdmin === true || context.admin === true || routeMeta.isAdmin === true || routeMeta.admin === true
  };
}

function normalizeTemplate(value = '') {
  const template = normalizeText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TEMPLATE_DEFAULTS, template) ? template : '';
}

function normalizeWorldbookRuntimeMeta(item = {}) {
  const template = normalizeTemplate(item.template);
  const defaults = TEMPLATE_DEFAULTS[template] || {};
  const hasDurationTurns = Object.prototype.hasOwnProperty.call(item, 'durationTurns');
  const hasDurationMs = Object.prototype.hasOwnProperty.call(item, 'durationMs');
  const durationTurns = Math.max(0, Math.floor(normalizeNumber(
    hasDurationTurns ? item.durationTurns : defaults.durationTurns,
    0
  )));
  const durationMs = Math.max(0, Math.floor(normalizeNumber(
    hasDurationMs ? item.durationMs : defaults.durationMs,
    0
  )));
  const activationMode = normalizeText(item.activationMode || defaults.activationMode || 'hit').toLowerCase();
  const probability = Math.max(0, Math.min(1, normalizeNumber(
    Object.prototype.hasOwnProperty.call(item, 'probability') ? item.probability : defaults.probability,
    1
  )));
  return {
    template,
    activationMode,
    durationTurns,
    durationMs,
    probability,
    scope: normalizeArray(item.scope).map((entry) => normalizeText(entry)).filter(Boolean),
    exampleIds: normalizeArray(item.exampleIds).map((entry) => normalizeText(entry)).filter(Boolean)
  };
}

function shouldPersistWorldbookModule(item = {}) {
  const meta = normalizeWorldbookRuntimeMeta(item);
  if (meta.activationMode === 'resident' || meta.activationMode === 'session') return true;
  return meta.durationTurns > 0 || meta.durationMs > 0;
}

function isScopeAllowed(meta = {}, context = {}) {
  const scope = normalizeArray(meta.scope).map((entry) => normalizeText(entry)).filter(Boolean);
  if (scope.length === 0) return true;
  const scopeContext = normalizeScopeContext(context);
  return scope.some((entry) => {
    if (entry === 'admin') return scopeContext.isAdmin;
    return entry === scopeContext.userId || entry === scopeContext.groupId || entry === scopeContext.sessionKey;
  });
}

function isProbabilityAllowed(meta = {}, random = Math.random) {
  const probability = Math.max(0, Math.min(1, normalizeNumber(meta.probability, 1)));
  if (probability >= 1) return true;
  if (probability <= 0) return false;
  return random() < probability;
}

function findModule(catalog = { modules: [] }, moduleId = '') {
  const id = normalizeText(moduleId);
  return normalizeArray(catalog.modules).find((item) => normalizeText(item?.id || item?.moduleId) === id) || null;
}

function getSessionStore(sessionKey = '') {
  const key = normalizeText(sessionKey);
  if (!key) return null;
  let store = stateBySession.get(key);
  if (!store) {
    store = new Map();
    stateBySession.set(key, store);
  }
  return store;
}

function buildStateSnapshot(entry = {}, now = Date.now()) {
  const remainingMs = Number(entry.expiresAt || 0) > 0
    ? Math.max(0, Number(entry.expiresAt || 0) - now)
    : 0;
  return {
    state: 'active',
    sessionKey: entry.sessionKey,
    activatedAt: entry.activatedAt,
    expiresAt: entry.expiresAt || 0,
    remainingMs,
    remainingTurns: entry.remainingTurns === null ? null : Math.max(0, Number(entry.remainingTurns || 0)),
    activationMode: normalizeText(entry.meta?.activationMode, 'session'),
    template: normalizeText(entry.meta?.template),
    source: normalizeText(entry.source)
  };
}

function isExpired(entry = {}, now = Date.now()) {
  if (Number(entry.expiresAt || 0) > 0 && now > Number(entry.expiresAt || 0)) return true;
  if (entry.remainingTurns !== null && Number(entry.remainingTurns || 0) <= 0) return true;
  return false;
}

function activateWorldbookSessionCandidates(candidates = [], context = {}, options = {}) {
  if (config.PERSONA_WORLDBOOK_SESSION_STATE_ENABLED === false) {
    return { activated: [], skipped: [{ reason: 'disabled' }] };
  }
  const sessionKey = getSessionKey(context);
  if (!sessionKey) return { activated: [], skipped: [{ reason: 'missing_session_key' }] };
  const store = getSessionStore(sessionKey);
  const now = Number(options.now || Date.now());
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const activated = [];
  const skipped = [];

  for (const raw of normalizeArray(candidates)) {
    const moduleId = normalizeText(raw?.moduleId || raw?.id);
    if (!moduleId) continue;
    const meta = normalizeWorldbookRuntimeMeta(raw);
    if (!shouldPersistWorldbookModule(raw)) {
      skipped.push({ moduleId, reason: 'not_persistent' });
      continue;
    }
    if (!isScopeAllowed(meta, context)) {
      skipped.push({ moduleId, reason: 'scope_blocked' });
      continue;
    }
    if (!isProbabilityAllowed(meta, random)) {
      skipped.push({ moduleId, reason: 'probability_miss' });
      continue;
    }
    const remainingTurns = meta.durationTurns > 0 ? meta.durationTurns : null;
    const expiresAt = meta.durationMs > 0 ? now + meta.durationMs : 0;
    const entry = {
      moduleId,
      sessionKey,
      activatedAt: now,
      expiresAt,
      remainingTurns,
      meta,
      source: normalizeText(raw.matchMode || raw.worldbookMatchMode || raw.reason || 'worldbook_hit')
    };
    store.set(moduleId, entry);
    activated.push({ moduleId, activationState: buildStateSnapshot(entry, now), linkedExamples: meta.exampleIds });
  }

  if (store.size === 0) stateBySession.delete(sessionKey);
  return { activated, skipped };
}

function decorateActivatedWorldbookCandidates(candidates = [], activationResult = {}, options = {}) {
  const byId = new Map(normalizeArray(activationResult.activated).map((entry) => [normalizeText(entry.moduleId), entry]));
  return normalizeArray(candidates).map((item) => {
    const moduleId = normalizeText(item?.moduleId || item?.id);
    const hit = byId.get(moduleId);
    if (!hit) return item;
    return {
      ...item,
      activationState: {
        ...hit.activationState,
        state: 'activated',
        justActivated: true
      },
      linkedExamples: normalizeArray(hit.linkedExamples),
      sessionLinkedExamples: normalizeArray(hit.linkedExamples),
      worldbookReason: normalizeText(item.worldbookReason || item.reason || 'worldbook hit activated session state')
    };
  });
}

function getActiveWorldbookSessionCandidates(catalog = { modules: [] }, context = {}, options = {}) {
  const sessionKey = getSessionKey(context);
  if (!sessionKey) return [];
  const store = stateBySession.get(sessionKey);
  if (!store || store.size === 0) return [];
  const now = Number(options.now || Date.now());
  const consume = options.consume !== false;
  const results = [];

  for (const [moduleId, entry] of Array.from(store.entries())) {
    if (isExpired(entry, now)) {
      store.delete(moduleId);
      continue;
    }
    const moduleItem = findModule(catalog, moduleId);
    if (!moduleItem) {
      store.delete(moduleId);
      continue;
    }
    if (!isScopeAllowed(entry.meta, context)) continue;
    const activationState = buildStateSnapshot(entry, now);
    results.push({
      ...moduleItem,
      id: moduleId,
      moduleId,
      worldbookScore: 0.82,
      worldbookMatchMode: 'session',
      worldbookReason: 'active_worldbook_session_state',
      matchMode: 'session',
      reason: 'active worldbook session state',
      activationState,
      linkedExamples: normalizeArray(entry.meta?.exampleIds),
      sessionLinkedExamples: normalizeArray(entry.meta?.exampleIds)
    });
    if (consume && entry.remainingTurns !== null) {
      entry.remainingTurns = Math.max(0, Number(entry.remainingTurns || 0) - 1);
      if (entry.remainingTurns <= 0) store.delete(moduleId);
    }
  }

  if (store.size === 0) stateBySession.delete(sessionKey);
  return results;
}

function getWorldbookSessionState(sessionKey = '') {
  const key = normalizeText(sessionKey);
  if (!key) return [];
  const store = stateBySession.get(key);
  if (!store) return [];
  const now = Date.now();
  return Array.from(store.values())
    .filter((entry) => !isExpired(entry, now))
    .map((entry) => ({
      moduleId: entry.moduleId,
      activationState: buildStateSnapshot(entry, now),
      linkedExamples: normalizeArray(entry.meta?.exampleIds)
    }));
}

function clearWorldbookSessionState(sessionKey = '') {
  const key = normalizeText(sessionKey);
  if (!key) {
    stateBySession.clear();
    return;
  }
  stateBySession.delete(key);
}

module.exports = {
  TEMPLATE_DEFAULTS,
  activateWorldbookSessionCandidates,
  clearWorldbookSessionState,
  decorateActivatedWorldbookCandidates,
  getActiveWorldbookSessionCandidates,
  getSessionKey,
  getWorldbookSessionState,
  normalizeWorldbookRuntimeMeta,
  shouldPersistWorldbookModule
};
