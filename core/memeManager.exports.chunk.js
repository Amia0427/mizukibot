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
    reindexQueued: reindexQueue.length
  });
  return current;
}

module.exports = {
  analyzeMemeAsset,
  cleanupExpiredSessions,
  consumePendingUploadFromMessage,
  drainReindexQueue,
  getReindexStatus,
  handleAdminCommand,
  initializeMemeManager,
  isSurfaceEnabled,
  maybeSendMemeFollowup,
  parseMemeCommand,
  pickBestAssetForSelection,
  resolveAssetAnalysis,
  runMemeTest,
  selectCategory,
  startUploadSession,
  evaluateMemeGate
};
