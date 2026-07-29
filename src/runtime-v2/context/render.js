'use strict';

const { buildBaseDynamicPrompt } = require('./base');
const { buildDynamicPrompt } = require('./dynamic');
const { formatResearchBriefsForPrompt } = require('./support');

module.exports = {
  buildBaseDynamicPrompt,
  buildDynamicPrompt,
  formatResearchBriefsForPrompt
};
