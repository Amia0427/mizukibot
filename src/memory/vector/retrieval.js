const vectorMemory = require('./index');

module.exports = {
  getCoreMemories: vectorMemory.getCoreMemories,
  retrieveRelevantMemories: vectorMemory.retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync: vectorMemory.retrieveRelevantMemoriesAsync,
  retrieveUnifiedMemories: vectorMemory.retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync: vectorMemory.retrieveUnifiedMemoriesAsync
};
