const RUNTIME_PLANNING_MODULE = './runtimeV2/planning/service';
const LEGACY_PLANNING_MODULE = './legacy/aiHost';
const config = require('../config');

function loadPlanningService() {
  try {
    const planningServicePath = require.resolve(RUNTIME_PLANNING_MODULE);
    if (config.AGENT_DEV_HOT_RELOAD) {
      delete require.cache[planningServicePath];
    }
    return require(RUNTIME_PLANNING_MODULE);
  } catch (error) {
    const missingRuntimePlanningModule =
      error?.code === 'MODULE_NOT_FOUND'
      && String(error.message || '').includes(RUNTIME_PLANNING_MODULE);
    if (!missingRuntimePlanningModule) throw error;

    const legacyPlanningPath = require.resolve(LEGACY_PLANNING_MODULE);
    if (config.AGENT_DEV_HOT_RELOAD) {
      delete require.cache[legacyPlanningPath];
    }
    console.warn('[graphPlanning] runtime planning service unavailable, falling back to legacy aiHost:', error.message);
    return require(LEGACY_PLANNING_MODULE);
  }
}

module.exports = loadPlanningService();
