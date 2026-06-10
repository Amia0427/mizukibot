const path = require('path');
const { createJsonHotStore } = require('../jsonHotStore');
const {
  STORE_FILE,
  STYLE_GLOBAL_FILE,
  STYLE_GROUP_DIR,
  ensureDir,
  normalizeId
} = require('./common');
const {
  defaultProfile,
  defaultStore,
  normalizeStore
} = require('./profileShape');

const styleRuntimeStores = {
  legacy: null,
  global: null,
  groups: new Map()
};

function getLegacyStore() {
  if (!styleRuntimeStores.legacy) {
    styleRuntimeStores.legacy = createJsonHotStore(STORE_FILE, {
      fallback: defaultStore
    });
  }
  return styleRuntimeStores.legacy;
}

function getGlobalStore() {
  if (!styleRuntimeStores.global) {
    styleRuntimeStores.global = createJsonHotStore(STYLE_GLOBAL_FILE, {
      fallback: () => ({
        version: 1,
        profile: defaultProfile(),
        samples: []
      })
    });
  }
  return styleRuntimeStores.global;
}

function getGroupStore(groupId = '') {
  const gid = normalizeId(groupId);
  if (!gid) return null;
  if (!styleRuntimeStores.groups.has(gid)) {
    styleRuntimeStores.groups.set(gid, createJsonHotStore(path.join(STYLE_GROUP_DIR, `${encodeURIComponent(gid)}.json`), {
      fallback: () => ({
        version: 1,
        profile: defaultProfile(),
        samples: []
      })
    }));
  }
  return styleRuntimeStores.groups.get(gid);
}

function readStore() {
  ensureDir(STORE_FILE);
  const globalState = getGlobalStore().read();
  const legacy = normalizeStore(getLegacyStore().read());
  const mergedGroups = {};
  for (const [groupId, value] of Object.entries(legacy.groupOverlays || {})) {
    const groupStore = getGroupStore(groupId);
    if (!groupStore) continue;
    const fromGroupFile = groupStore.read();
    const normalized = normalizeStore({
      groupOverlays: {
        [groupId]: fromGroupFile
      }
    }).groupOverlays[groupId];
    mergedGroups[groupId] = normalized || value;
  }
  return normalizeStore({
    version: 1,
    globalBotBase: globalState,
    groupOverlays: mergedGroups
  });
}

function writeStore(store) {
  const normalized = normalizeStore(store);
  getGlobalStore().replace({
    version: 1,
    profile: normalized.globalBotBase.profile,
    samples: normalized.globalBotBase.samples
  });
  for (const [groupId, entry] of Object.entries(normalized.groupOverlays || {})) {
    const groupStore = getGroupStore(groupId);
    if (!groupStore) continue;
    groupStore.replace({
      version: 1,
      profile: entry.profile,
      samples: entry.samples
    });
  }
  getLegacyStore().replace(normalized);
}

module.exports = {
  getGlobalStore,
  getGroupStore,
  getLegacyStore,
  readStore,
  writeStore
};
