'use strict';

const fs = require('fs');
const config = require('../../../config');

const followupRuntime = new Map();

let runtimeStoreCache = { groups: {}, assets: {} };

function ensureRuntimeStoreShape(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const groupsInput = source.groups && typeof source.groups === 'object' ? source.groups : {};
  const assetsInput = source.assets && typeof source.assets === 'object' ? source.assets : {};
  const groups = {};
  const assets = {};

  for (const [groupId, state] of Object.entries(groupsInput)) {
    groups[String(groupId || '').trim()] = {
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0),
      recentAssetIds: (Array.isArray(state?.recentAssetIds) ? state.recentAssetIds : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      recentCategoryNames: (Array.isArray(state?.recentCategoryNames) ? state.recentCategoryNames : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      lastMood: String(state?.lastMood || '').trim()
    };
  }

  for (const [assetId, state] of Object.entries(assetsInput)) {
    assets[String(assetId || '').trim()] = {
      sentCount: Math.max(0, Number(state?.sentCount) || 0),
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0)
    };
  }

  return { groups, assets };
}

function safeReadRuntimeStore() {
  try {
    if (!fs.existsSync(config.MEME_MANAGER_RUNTIME_FILE)) {
      return ensureRuntimeStoreShape();
    }
    const raw = fs.readFileSync(config.MEME_MANAGER_RUNTIME_FILE, 'utf8').trim();
    if (!raw) return ensureRuntimeStoreShape();
    return ensureRuntimeStoreShape(JSON.parse(raw));
  } catch (error) {
    console.error('[meme-manager] failed to read runtime store:', error?.message || String(error));
    return ensureRuntimeStoreShape();
  }
}

function persistRuntimeStore() {
  const serialized = JSON.stringify(runtimeStoreCache, null, 2);
  const target = config.MEME_MANAGER_RUNTIME_FILE;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, serialized, 'utf8');
  fs.renameSync(temp, target);
}

function loadRuntimeStore() {
  runtimeStoreCache = safeReadRuntimeStore();
  return runtimeStoreCache;
}

function trimRecentWindow(list = [], limit = 0) {
  const normalizedLimit = Math.max(0, Number(limit) || 0);
  if (normalizedLimit === 0) return [];
  return list.slice(-normalizedLimit);
}

function getFollowupRuntime(groupId = '') {
  const key = String(groupId || '').trim() || '__default__';
  const runtime = followupRuntime.get(key) || runtimeStoreCache.groups[key];
  if (runtime && typeof runtime === 'object') {
    return {
      lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
      recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
      recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
      lastMood: String(runtime.lastMood || '').trim()
    };
  }
  return {
    lastSentAt: 0,
    recentAssetIds: [],
    recentCategoryNames: [],
    lastMood: ''
  };
}

function setFollowupRuntime(groupId = '', runtime = {}) {
  const key = String(groupId || '').trim() || '__default__';
  const normalized = {
    lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
    recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
    recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
    lastMood: String(runtime.lastMood || '').trim()
  };
  followupRuntime.set(key, normalized);
  runtimeStoreCache.groups[key] = {
    ...normalized,
    recentAssetIds: normalized.recentAssetIds.slice(),
    recentCategoryNames: normalized.recentCategoryNames.slice()
  };
  persistRuntimeStore();
}

function buildRuntimeSummary(groupId = '', now = Date.now()) {
  const runtime = getFollowupRuntime(groupId);
  const cooldownMs = Math.max(0, Number(config.MEME_MANAGER_GROUP_COOLDOWN_MS) || 0);
  const cooldownRemainingMs = Math.max(0, cooldownMs - Math.max(0, now - runtime.lastSentAt));
  return {
    ...runtime,
    cooldownRemainingMs
  };
}

function updateFollowupRuntime(groupId = '', selection = {}, asset = {}, now = Date.now()) {
  const previous = getFollowupRuntime(groupId);
  const recentAssetWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_ASSET_WINDOW) || 0);
  const recentCategoryWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_CATEGORY_WINDOW) || 0);
  const nextAssetIds = trimRecentWindow(
    [...previous.recentAssetIds, String(asset?.id || '').trim()].filter(Boolean),
    recentAssetWindow
  );
  const nextCategoryNames = trimRecentWindow(
    [...previous.recentCategoryNames, String(selection?.selectedCategory || '').trim()].filter(Boolean),
    recentCategoryWindow
  );
  setFollowupRuntime(groupId, {
    lastSentAt: Math.max(0, Number(now) || Date.now()),
    recentAssetIds: nextAssetIds,
    recentCategoryNames: nextCategoryNames,
    lastMood: String(selection?.mood || '').trim()
  });
  const assetId = String(asset?.id || '').trim();
  if (assetId) {
    const currentAssetRuntime = runtimeStoreCache.assets[assetId] || { sentCount: 0, lastSentAt: 0 };
    runtimeStoreCache.assets[assetId] = {
      sentCount: Math.max(0, Number(currentAssetRuntime.sentCount) || 0) + 1,
      lastSentAt: Math.max(0, Number(now) || Date.now())
    };
    persistRuntimeStore();
  }
}

module.exports = {
  followupRuntime,
  get runtimeStoreCache() {
    return runtimeStoreCache;
  },
  ensureRuntimeStoreShape,
  safeReadRuntimeStore,
  persistRuntimeStore,
  loadRuntimeStore,
  trimRecentWindow,
  getFollowupRuntime,
  setFollowupRuntime,
  buildRuntimeSummary,
  updateFollowupRuntime
};
