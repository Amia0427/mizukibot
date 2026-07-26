const stats = require('./stats-runtime');

module.exports = {
  getMemoryStats: stats.getMemoryStats,
  touchAccessStats: stats.touchAccessStats
};
