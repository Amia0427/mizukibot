const { PROJECTION_FILE } = require('./memoryProjection/common');
const {
  flushScheduledProjectionSave,
  loadProjection,
  saveProjection,
  scheduleProjectionSave
} = require('./memoryProjection/persistence');
const { buildProjection, projectUserProfile } = require('./memoryProjection/projector');

function buildMigrationReport(...args) {
  return require('./memoryProjection/migration').buildMigrationReport(...args);
}

function runMemoryMigration(...args) {
  return require('./memoryProjection/migration').runMemoryMigration(...args);
}

module.exports = {
  PROJECTION_FILE,
  buildProjection,
  buildMigrationReport,
  flushScheduledProjectionSave,
  loadProjection,
  projectUserProfile,
  runMemoryMigration,
  scheduleProjectionSave,
  saveProjection
};
