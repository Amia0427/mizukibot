const { createCompanionVoiceClient } = require('./client');
const { getCompanionVoiceService } = require('./runtime');
const { createCompanionVoiceService } = require('./service');

module.exports = {
  createCompanionVoiceClient,
  createCompanionVoiceService,
  getCompanionVoiceService
};
