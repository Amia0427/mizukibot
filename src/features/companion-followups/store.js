const { createJsonHotStore } = require('../../../utils/jsonHotStore');

const STATE_VERSION = 1;
const STATUSES = new Set(['open', 'completed', 'snoozed', 'abandoned']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    nextId: 1,
    items: {}
  };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeItem(value = {}) {
  const status = normalizeText(value.status).toLowerCase();
  return {
    id: normalizeText(value.id),
    userId: normalizeText(value.userId || value.user_id),
    title: normalizeText(value.title).slice(0, 160),
    note: normalizeText(value.note).slice(0, 500),
    dueAt: normalizeText(value.dueAt || value.due_at),
    status: STATUSES.has(status) ? status : 'open',
    createdAt: Number(value.createdAt || value.created_at || 0) || 0,
    updatedAt: Number(value.updatedAt || value.updated_at || 0) || 0,
    completedAt: Number(value.completedAt || value.completed_at || 0) || 0
  };
}

function normalizeState(value = {}) {
  const normalized = defaultState();
  normalized.nextId = Math.max(1, Math.floor(Number(value.nextId || 1) || 1));
  const items = value.items && typeof value.items === 'object' && !Array.isArray(value.items)
    ? value.items
    : {};
  for (const [id, valueItem] of Object.entries(items)) {
    const item = normalizeItem({ ...valueItem, id: valueItem?.id || id });
    if (item.id && item.userId && item.title) normalized.items[item.id] = item;
  }
  return normalized;
}

function createFollowupStateStore(filePath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const hotStore = options.hotStore || createJsonHotStore(filePath, {
    fallback: defaultState,
    deserialize(raw) {
      return normalizeState(JSON.parse(raw));
    }
  });

  function read() {
    return clone(normalizeState(hotStore.read()));
  }

  function list(userId, filters = {}) {
    const id = normalizeText(userId);
    const statuses = Array.isArray(filters.statuses)
      ? new Set(filters.statuses.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))
      : null;
    return Object.values(read().items)
      .filter((item) => item.userId === id)
      .filter((item) => !statuses || statuses.size === 0 || statuses.has(item.status))
      .sort((left, right) => (
        String(left.dueAt || '9999-12-31 23:59').localeCompare(String(right.dueAt || '9999-12-31 23:59'))
        || Number(left.createdAt || 0) - Number(right.createdAt || 0)
      ));
  }

  function get(userId, itemId) {
    const id = normalizeText(itemId);
    const item = read().items[id];
    return item && item.userId === normalizeText(userId) ? item : null;
  }

  function create(userId, input = {}) {
    const ownerId = normalizeText(userId);
    const nowValue = Number(input.now || now()) || now();
    let result;
    hotStore.update((state) => {
      const nextState = normalizeState(state);
      const itemId = `followup_${nextState.nextId}`;
      nextState.nextId += 1;
      result = normalizeItem({
        id: itemId,
        userId: ownerId,
        title: input.title,
        note: input.note,
        dueAt: input.dueAt,
        status: 'open',
        createdAt: nowValue,
        updatedAt: nowValue
      });
      nextState.items[itemId] = result;
      return nextState;
    }, { flushNow: true });
    return clone(result);
  }

  function update(userId, itemId, mutator, options = {}) {
    const ownerId = normalizeText(userId);
    const id = normalizeText(itemId);
    let result = null;
    hotStore.update((state) => {
      const nextState = normalizeState(state);
      const current = nextState.items[id];
      if (!current || current.userId !== ownerId) return nextState;
      const next = typeof mutator === 'function' ? mutator(clone(current)) : current;
      result = normalizeItem({ ...current, ...next, id, userId: ownerId, updatedAt: Number(options.now || now()) || now() });
      nextState.items[id] = result;
      return nextState;
    }, { flushNow: options.flushNow !== false });
    return result ? clone(result) : null;
  }

  function remove(userId, itemId) {
    const ownerId = normalizeText(userId);
    const id = normalizeText(itemId);
    let removed = false;
    hotStore.update((state) => {
      const nextState = normalizeState(state);
      if (nextState.items[id]?.userId === ownerId) {
        delete nextState.items[id];
        removed = true;
      }
      return nextState;
    }, { flushNow: true });
    return removed;
  }

  return {
    create,
    flush: () => hotStore.flushSync(),
    get,
    list,
    read,
    remove,
    update
  };
}

module.exports = {
  STATE_VERSION,
  STATUSES,
  createFollowupStateStore,
  defaultState,
  normalizeItem,
  normalizeState
};
