const config = require('../../../config');
const { createCompanionVoiceService } = require('./service');

let service;

function initializeCompanionVoiceService(options = {}) {
  service = createCompanionVoiceService({
    config: options.config || config,
    provider: options.provider,
    client: options.client,
    canSendAudio: options.canSendAudio,
    sendAudio: options.sendAudio,
    sendText: options.sendText,
    sendPrivateVoiceMessage: options.sendPrivateVoiceMessage
  });
  return service;
}

function getCompanionVoiceService() {
  if (!service) service = initializeCompanionVoiceService({ config });
  return service;
}

module.exports = {
  getCompanionVoiceService,
  initializeCompanionVoiceService
};
