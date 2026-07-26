'use strict';

const config = require('../../../config');
const memeStore = require('../../../utils/memeStore');
const { followupRuntime, loadRuntimeStore } = require('./runtime-state');
const { enqueueReindexTasks, getReindexStatus } = require('./reindex-runtime');

function initializeMemeManager() {
  const current = memeStore.initializeStore();
  followupRuntime.clear();
  loadRuntimeStore();
  if (config.MEME_MANAGER_REINDEX_ON_STARTUP) {
    const tasks = memeStore.listAssetsNeedingAnalysis().map((item) => ({
      categoryName: item.categoryName,
      assetId: item.asset.id
    }));
    enqueueReindexTasks(tasks);
  }
  console.log('[meme-manager] initialized', {
    enabled: current.enabled,
    categoryCount: Object.keys(current.categories || {}).length,
    reindexQueued: getReindexStatus().queued
  });
  return current;
}

module.exports = { initializeMemeManager };
