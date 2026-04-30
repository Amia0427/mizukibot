const { appendMemoryEvent, normalizeMemoryEvent, loadMemoryEvents } = require('./events');
const { materializeMemoryViews } = require('./materializer');
const { queryMemory } = require('./query');
const { assembleMemoryPacket } = require('./packet');
const { restoreSessionState } = require('./session');
const { migrateLegacyMemoryToV3 } = require('./migration');
const { diagnoseProjectionFreshness } = require('./diagnostics');

module.exports = {
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  materializeMemoryViews,
  queryMemory,
  assembleMemoryPacket,
  restoreSessionState,
  migrateLegacyMemoryToV3,
  diagnoseProjectionFreshness
};
