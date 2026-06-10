const { collectTopCounts, normalizeNumber, normalizeText } = require('./common');

function extractModuleName(row = {}) {
  return normalizeText(
    row.module
    || row.component
    || row.node
    || row.type
    || row.category
    || row.routePolicyKey
    || 'unknown'
  ) || 'unknown';
}

function buildModuleSummary(perfEvents = []) {
  const topModules = collectTopCounts(perfEvents, extractModuleName, 10);
  const topTypes = collectTopCounts(perfEvents, (row) => row.type || row.event || row.stage || row.category, 10);
  const backgroundPressure = perfEvents.filter((row) => normalizeText(row.category) === 'background_pressure');
  return {
    eventCount: perfEvents.length,
    topModules,
    topTypes,
    backgroundPressure: {
      count: backgroundPressure.length,
      topTypes: collectTopCounts(backgroundPressure, 'type', 6),
      maxDelayMs: backgroundPressure.reduce((max, row) => Math.max(max, normalizeNumber(row.delayMs, 0)), 0)
    }
  };
}

module.exports = {
  buildModuleSummary,
  extractModuleName
};
