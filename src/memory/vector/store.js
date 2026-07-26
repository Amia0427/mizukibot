const store = require('./store-runtime');

module.exports = {
  loadIndex: store.loadIndex,
  loadLibrary: store.loadLibrary,
  getMemoryItems: store.getMemoryItems,
  getMemoryItemsByFilter: store.getMemoryItemsByFilter,
  rebuildMemoryIndex: store.rebuildMemoryIndex,
  saveIndex: store.saveIndex,
  saveLibrary: store.saveLibrary
};
