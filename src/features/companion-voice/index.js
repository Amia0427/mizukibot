const { createCompanionVoiceClient } = require('./client');
const { getCompanionVoiceService, initializeCompanionVoiceService } = require('./runtime');
const {
  createCompanionVoiceProvider,
  createExternalTtsProvider,
  createGeneratedAudio,
  createLocalTtsProvider,
  isRetryableTtsError
} = require('./provider');
const { createCompanionVoiceService } = require('./service');

module.exports = {
  createCompanionVoiceClient,
  createCompanionVoiceProvider,
  createCompanionVoiceService,
  createExternalTtsProvider,
  createGeneratedAudio,
  createLocalTtsProvider,
  getCompanionVoiceService,
  initializeCompanionVoiceService,
  isRetryableTtsError
};
