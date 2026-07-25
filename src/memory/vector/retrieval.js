const retrieval = require('./retrieval-runtime');

module.exports = {
  getCoreMemories: retrieval.getCoreMemories,
  retrieveRelevantMemories: retrieval.retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync: retrieval.retrieveRelevantMemoriesAsync,
  retrieveUnifiedMemories: retrieval.retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync: retrieval.retrieveUnifiedMemoriesAsync
};
