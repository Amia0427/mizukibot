const { appendMemoryEvent, normalizeMemoryEvent, loadMemoryEvents } = require('./events');
const { materializeMemoryViews } = require('./materializer');
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

module.exports = {
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  materializeMemoryViews,
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
  getMemoryRecallPolicyResource
};
