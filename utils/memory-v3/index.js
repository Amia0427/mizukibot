const { appendMemoryEvent, normalizeMemoryEvent, loadMemoryEvents } = require('./events');
const { materializeMemoryViews, materializeMemoryViewsAsync } = require('./materializer');
const { queryMemory } = require('./query');
const { assembleMemoryPacket } = require('./packet');
const { restoreSessionState } = require('./session');
const { migrateLegacyMemoryToV3 } = require('./migration');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const { runProfileMemoryMaintenance } = require('./profileMaintenance');
const {
  appendVersionedMemoryUpdate,
  findSimilarMemoryForUpdate
} = require('./versionedUpdate');
const {
  importMemoryFile,
  splitMemoryImportChunks
} = require('./fileImport');
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

module.exports = {
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  materializeMemoryViews,
  materializeMemoryViewsAsync,
  queryMemory,
  assembleMemoryPacket,
  restoreSessionState,
  migrateLegacyMemoryToV3,
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
