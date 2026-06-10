const vectorMemory = require('./index');

module.exports = {
  addEpisodeMemory: vectorMemory.addEpisodeMemory,
  addMemoryItem: vectorMemory.addMemoryItem,
  addMemoryItemsBatch: vectorMemory.addMemoryItemsBatch,
  addMemoryItemsBatchAsync: vectorMemory.addMemoryItemsBatchAsync,
  addMemoryItemsBatchWithVectorBackfill: vectorMemory.addMemoryItemsBatchWithVectorBackfill,
  rememberExplicitMemory: vectorMemory.rememberExplicitMemory
};
