const {
  ACTIONS,
  createCompanionFollowupService,
  formatNow
} = require('./service');
const {
  createFollowupStateStore,
  defaultState,
  normalizeItem,
  normalizeState
} = require('./store');

module.exports = {
  ACTIONS,
  createCompanionFollowupService,
  createFollowupStateStore,
  defaultState,
  formatNow,
  normalizeItem,
  normalizeState
};
