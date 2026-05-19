const config = require('../../config');
const {
  loadMemoryNodes
} = require('./storage');
const { normalizeText } = require('./helpers');
const {
  materializeMemoryViews
} = require('./materializer');
const {
  findProfileCleanupCandidates
} = require('./profileLifecycle');

const maintenanceState = {
  running: false,
  lastRunAt: 0,
  lastResult: null
};

function isProfileMaintenanceEnabled(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'enabled')) return options.enabled === true;
  return config.MEMORY_PROFILE_MAINTENANCE_ENABLED === true;
}

function shouldRunProfileMaintenance(options = {}) {
  if (options.force === true) return true;
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.MEMORY_PROFILE_MAINTENANCE_INTERVAL_MS) || 0);
  if (!intervalMs) return true;
  const elapsedMs = Date.now() - Math.max(0, Number(maintenanceState.lastRunAt || 0) || 0);
  return elapsedMs >= intervalMs;
}

function summarizeCleanupCandidates(items = []) {
  const countsByReason = {};
  const countsByStatus = {};
  for (const item of Array.isArray(items) ? items : []) {
    const reason = String(item.reason || 'unknown').trim() || 'unknown';
    const status = String(item.lifecycleStatus || 'unknown').trim() || 'unknown';
    countsByReason[reason] = (countsByReason[reason] || 0) + 1;
    countsByStatus[status] = (countsByStatus[status] || 0) + 1;
  }
  return { countsByReason, countsByStatus };
}

async function runProfileMemoryMaintenance(options = {}) {
  if (!isProfileMaintenanceEnabled(options)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (maintenanceState.running && options.force !== true) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }
  if (!shouldRunProfileMaintenance(options)) {
    return { ok: true, skipped: true, reason: 'throttled', lastResult: maintenanceState.lastResult };
  }

  maintenanceState.running = true;
  maintenanceState.lastRunAt = Date.now();
  const startedAt = Date.now();
  try {
    const refreshed = options.force === true && options.skipMaterialize !== true
      ? materializeMemoryViews({
        force: options.force === true,
        scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill === true
      })
      : null;
    const userId = normalizeText(options.userId);
    const allNodes = Array.isArray(refreshed?.nodes) ? refreshed.nodes : loadMemoryNodes();
    const nodes = userId
      ? allNodes.filter((node) => normalizeText(node.userId) === userId)
      : allNodes;
    const cleanupCandidates = findProfileCleanupCandidates(nodes, options);
    const hardDeleteCandidates = cleanupCandidates.filter((item) => item.hardDeleteEligible);
    const summary = {
      ok: true,
      skipped: false,
      durationMs: Date.now() - startedAt,
      nodes: nodes.length,
      cleanupCandidates: cleanupCandidates.length,
      hardDeleteCandidates: hardDeleteCandidates.length,
      ...summarizeCleanupCandidates(cleanupCandidates),
      materialized: Boolean(refreshed && refreshed.ok !== false)
    };
    maintenanceState.lastResult = summary;
    return {
      ...summary,
      candidates: cleanupCandidates.slice(0, Math.max(1, Number(options.limit || 20) || 20))
    };
  } finally {
    maintenanceState.running = false;
  }
}

module.exports = {
  isProfileMaintenanceEnabled,
  runProfileMemoryMaintenance,
  summarizeCleanupCandidates
};
