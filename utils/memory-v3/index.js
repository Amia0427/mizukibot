const { appendMemoryEvent, normalizeMemoryEvent, loadMemoryEvents } = require('./events');
const {
  archiveMemory,
  findActiveMemoryNode,
  queryMemory,
  writeMemoryBatch
} = require('./repository');
const { assembleMemoryPacket } = require('./packet');
const { restoreSessionState } = require('./session');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const {
  appendVersionedMemoryUpdate,
  findSimilarMemoryForUpdate
} = require('./versionedUpdate');
const {
  getMemoryRecallPolicyResource
} = require('./recallPolicyResource');
const {
  resolveMemoryConflicts
} = require('./memoryConflictResolver');
const {
  addMemoryAlias,
  listMemoryAliases,
  removeMemoryAlias,
  resolveMemoryAlias
} = require('./aliasIndex');
const {
  buildBootMemory
} = require('./bootMemory');
const {
  acceptChangeset,
  listPendingChangesets,
  rejectChangeset
} = require('./changesetReview');
const {
  addMemoryTriggers,
  listMemoryTriggers,
  matchMemoryTriggers,
  removeMemoryTriggers
} = require('./triggerGlossary');
const {
  buildMemoryUriTree,
  readMemoryUri,
  searchMemoryUris,
  uriForDoc
} = require('./uriResolver');

function migrateLegacyMemoryToV3(...args) {
  return require('./migration').migrateLegacyMemoryToV3(...args);
}

function materializeMemoryViews(...args) {
  return require('./materializer').materializeMemoryViews(...args);
}

function materializeMemoryViewsAsync(...args) {
  return require('./materializer').materializeMemoryViewsAsync(...args);
}

function applyStrictArchiveRun(...args) {
  return require('./archiveRuns').applyStrictArchiveRun(...args);
}

function restoreArchiveRun(...args) {
  return require('./archiveRuns').restoreArchiveRun(...args);
}

function runProfileMemoryMaintenance(...args) {
  return require('./profileMaintenance').runProfileMemoryMaintenance(...args);
}

function importMemoryFile(...args) {
  return require('./fileImport').importMemoryFile(...args);
}

function splitMemoryImportChunks(...args) {
  return require('./fileImport').splitMemoryImportChunks(...args);
}

function buildConvergencePlan(...args) {
  return require('./convergence').buildConvergencePlan(...args);
}

function saveConvergencePlan(...args) {
  return require('./convergence').saveConvergencePlan(...args);
}

function applyConvergencePlan(...args) {
  return require('./convergence').applyConvergencePlan(...args);
}

function rollbackConvergenceRun(...args) {
  return require('./convergence').rollbackConvergenceRun(...args);
}

function archiveLegacyFiles(...args) {
  return require('./legacyArchive').archiveLegacyFiles(...args);
}

function restoreLegacyArchive(...args) {
  return require('./legacyArchive').restoreLegacyArchive(...args);
}

module.exports = {
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  materializeMemoryViews,
  materializeMemoryViewsAsync,
  archiveMemory,
  findActiveMemoryNode,
  queryMemory,
  writeMemoryBatch,
  applyStrictArchiveRun,
  restoreArchiveRun,
  assembleMemoryPacket,
  restoreSessionState,
  migrateLegacyMemoryToV3,
  buildConvergencePlan,
  saveConvergencePlan,
  applyConvergencePlan,
  rollbackConvergenceRun,
  archiveLegacyFiles,
  restoreLegacyArchive,
  diagnoseProjectionFreshness,
  runProfileMemoryMaintenance,
  appendVersionedMemoryUpdate,
  findSimilarMemoryForUpdate,
  importMemoryFile,
  splitMemoryImportChunks,
  getMemoryRecallPolicyResource,
  resolveMemoryConflicts,
  addMemoryAlias,
  listMemoryAliases,
  removeMemoryAlias,
  resolveMemoryAlias,
  buildBootMemory,
  acceptChangeset,
  listPendingChangesets,
  rejectChangeset,
  addMemoryTriggers,
  listMemoryTriggers,
  matchMemoryTriggers,
  removeMemoryTriggers,
  buildMemoryUriTree,
  readMemoryUri,
  searchMemoryUris,
  uriForDoc
};
