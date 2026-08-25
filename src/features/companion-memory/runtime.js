const config = require('../../../config');
const { createCompanionMemoryService } = require('./service');

let service;

function getCompanionMemoryService() {
  if (!service) service = createCompanionMemoryService({ config });
  return service;
}

module.exports = {
  getCompanionMemoryService
};
