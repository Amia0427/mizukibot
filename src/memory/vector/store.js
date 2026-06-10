const vectorMemory = require('./index');

module.exports = {
  loadIndex: vectorMemory.loadIndex,
  loadLibrary: vectorMemory.loadLibrary,
  getMemoryItems: vectorMemory.getMemoryItems,
  getMemoryItemsByFilter: vectorMemory.getMemoryItemsByFilter,
  rebuildMemoryIndex: vectorMemory.rebuildMemoryIndex,
  saveIndex: vectorMemory.saveIndex,
  saveLibrary: vectorMemory.saveLibrary
};
