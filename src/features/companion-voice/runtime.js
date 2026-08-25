const config = require('../../../config');
const { createCompanionVoiceService } = require('./service');

let service;

function getCompanionVoiceService() {
  if (!service) service = createCompanionVoiceService({ config });
  return service;
}

module.exports = {
  getCompanionVoiceService
};
