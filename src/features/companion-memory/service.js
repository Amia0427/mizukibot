const path = require('path');
const config = require('../../../config');
const { loadMemoryNodesForUser } = require('../../../utils/memory-v3/storage');
const { archiveMemory, writeMemoryBatch } = require('../../../utils/memory-v3');
const { createCompanionMemorySettingsStore } = require('./store');

const ACTIONS = new Set(['list', 'remember', 'correct', 'forget', 'settings', 'set_auto']);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toPublicItem(node = {}) {
  return {
    id: normalizeText(node.id || node.nodeId),
    text: normalizeText(node.text),
    category: normalizeText(node.category || node.memoryKind || node.type || 'fact'),
    updatedAt: Number(node.updatedAt || node.createdAt || 0) || 0
  };
}

function createCompanionMemoryService(options = {}) {
  const runtimeConfig = options.config || config;
  const settingsStore = options.settingsStore || createCompanionMemorySettingsStore(
    runtimeConfig.COMPANION_MEMORY_SETTINGS_FILE
      || path.join(runtimeConfig.DATA_DIR, 'companion-memory-settings.json')
  );
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  function requireUserId(userId) {
    const id = normalizeText(userId);
    if (!id) throw new Error('companion memory requires a private userId');
    return id;
  }

  function list(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const query = normalizeText(input.query).toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(input.limit || 20) || 20));
    return loadMemoryNodesForUser(ownerId)
      .filter((node) => normalizeText(node.status || 'active').toLowerCase() !== 'archived')
      .filter((node) => normalizeText(node.scopeType || 'personal').toLowerCase() !== 'group')
      .filter((node) => !query || normalizeText(node.text).toLowerCase().includes(query))
      .sort((left, right) => Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0))
      .slice(0, limit)
      .map(toPublicItem);
  }

  async function remember(userId, input = {}, context = {}) {
    const ownerId = requireUserId(userId);
    const text = normalizeText(input.text);
    if (!text) throw new Error('memory text is required');
    const result = await writeMemoryBatch([{
      userId: ownerId,
      type: 'fact',
      text,
      source: 'companion_memory',
      sourceKind: 'explicit',
      status: 'active',
      confidence: 1,
      importance: 1,
      scopeType: 'personal'
    }], {
      phase: 'companion_memory_remember',
      now: now(),
      enableVersionedUpdate: context.enableVersionedUpdate,
      scheduleEmbeddingBackfill: false
    });
    if (result.accepted.length !== 1) throw new Error(result.rejected[0]?.reason || 'memory write failed');
    return toPublicItem(result.accepted[0]);
  }

  async function correct(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const current = list(ownerId, { limit: 50 }).find((item) => item.id === normalizeText(input.id));
    if (!current) throw new Error('memory not found');
    const replacement = await remember(ownerId, { text: input.text }, { enableVersionedUpdate: false });
    const archived = await archiveMemory(current.id, {
      userId: ownerId,
      reason: 'user_corrected',
      source: 'companion_memory',
      now: now()
    });
    if (!archived.ok) throw new Error('memory archive failed');
    return replacement;
  }

  async function forget(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const result = await archiveMemory(input.id, {
      userId: ownerId,
      reason: 'user_forgotten',
      source: 'companion_memory',
      now: now()
    });
    if (!result.ok) throw new Error('memory not found');
    return normalizeText(result.event?.id || input.id);
  }

  function isAutoMemoryEnabled(userId) {
    return settingsStore.isAutoMemoryEnabled(requireUserId(userId));
  }

  function setAutoMemoryEnabled(userId, enabled) {
    return settingsStore.setAutoMemoryEnabled(requireUserId(userId), enabled);
  }

  async function execute(userId, args = {}) {
    const action = normalizeText(args.action).toLowerCase();
    if (!ACTIONS.has(action)) throw new Error('companion_memory action 不支持');
    if (action === 'list') return { action, items: list(userId, args) };
    if (action === 'remember') return { action, item: await remember(userId, args) };
    if (action === 'correct') return { action, item: await correct(userId, args) };
    if (action === 'forget') return { action, id: await forget(userId, args) };
    if (action === 'set_auto') return { action, autoMemoryEnabled: setAutoMemoryEnabled(userId, args.enabled) };
    return { action, autoMemoryEnabled: isAutoMemoryEnabled(userId) };
  }

  return {
    execute,
    isAutoMemoryEnabled,
    list,
    setAutoMemoryEnabled,
    settingsStore
  };
}

module.exports = {
  ACTIONS,
  createCompanionMemoryService,
  toPublicItem
};
