const vectorMemory = require('./index');

module.exports = {
  getMemoryStats: vectorMemory.getMemoryStats,
  touchAccessStats: vectorMemory.touchAccessStats
};
