const { PROJECTION_FILE } = require('./memoryProjection/common');
const { buildMigrationReport, runMemoryMigration } = require('./memoryProjection/migration');
const {
  flushScheduledProjectionSave,
  loadProjection,
  saveProjection,
  scheduleProjectionSave
} = require('./memoryProjection/persistence');
const { buildProjection, projectUserProfile } = require('./memoryProjection/projector');

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
