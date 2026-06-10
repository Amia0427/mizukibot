const {
  PROJECTION_FILE,
  atomicWriteJson,
  safeReadJson
} = require('./common');
const { buildProjection } = require('./projector');

function saveProjection(projection = null) {
  const next = projection && typeof projection === 'object'
    ? projection
    : buildProjection();
  atomicWriteJson(PROJECTION_FILE, next);
  return next;
}

let projectionFlushTimer = null;
let projectionDirty = false;

function scheduleProjectionSave(delayMs = 5000) {
  const waitMs = Math.max(500, Number(delayMs) || 5000);
  projectionDirty = true;
  if (projectionFlushTimer) return false;
  projectionFlushTimer = setTimeout(() => {
    projectionFlushTimer = null;
    if (!projectionDirty) return;
    projectionDirty = false;
    try {
      saveProjection();
    } catch (error) {
      projectionDirty = true;
      console.error('[memory_projection] scheduled save failed:', error?.message || error);
    }
  }, waitMs);
  return true;
}

function flushScheduledProjectionSave() {
  if (projectionFlushTimer) {
    clearTimeout(projectionFlushTimer);
    projectionFlushTimer = null;
  }
  if (!projectionDirty) return false;
  projectionDirty = false;
  saveProjection();
  return true;
}

function loadProjection() {
  const fallback = {
    version: 1,
    generatedAt: 0,
    users: {},
    favorites: {}
  };
  const loaded = safeReadJson(PROJECTION_FILE, fallback);
  if (!loaded || typeof loaded !== 'object') return fallback;
  if (!loaded.users || typeof loaded.users !== 'object') loaded.users = {};
  if (!loaded.favorites || typeof loaded.favorites !== 'object') loaded.favorites = {};
  return loaded;
}

module.exports = {
  flushScheduledProjectionSave,
  loadProjection,
  saveProjection,
  scheduleProjectionSave
};
