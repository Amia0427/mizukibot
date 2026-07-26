const embedding = require('./embedding');
const retrieval = require('./retrieval-runtime');
const stats = require('./stats-runtime');
const store = require('./store-runtime');
const write = require('./write-runtime');

module.exports = {
  addEpisodeMemory: write.addEpisodeMemory,
  addMemoryItem: write.addMemoryItem,
  addMemoryItemsBatch: write.addMemoryItemsBatch,
  addMemoryItemsBatchAsync: write.addMemoryItemsBatchAsync,
  addMemoryItemsBatchWithVectorBackfill: write.addMemoryItemsBatchWithVectorBackfill,
  cosineArray: embedding.cosineArray,
  getCoreMemories: retrieval.getCoreMemories,
  getMemoryItems: store.getMemoryItems,
  getMemoryItemsByFilter: store.getMemoryItemsByFilter,
  getMemoryStats: stats.getMemoryStats,
  loadIndex: store.loadIndex,
  loadLibrary: store.loadLibrary,
  rebuildMemoryIndex: store.rebuildMemoryIndex,
  rememberExplicitMemory: write.rememberExplicitMemory,
  requestEmbedding: embedding.requestEmbedding,
  retrieveRelevantMemories: retrieval.retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync: retrieval.retrieveRelevantMemoriesAsync,
  retrieveUnifiedMemories: retrieval.retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync: retrieval.retrieveUnifiedMemoriesAsync,
  saveIndex: store.saveIndex,
  saveLibrary: store.saveLibrary,
  shouldUseRemoteEmbedding: embedding.shouldUseRemoteEmbedding,
  touchAccessStats: stats.touchAccessStats
};
