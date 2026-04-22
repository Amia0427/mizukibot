const contextServicePath = require.resolve('./runtimeV2/context/service');
const config = require('../config');

if (config.AGENT_DEV_HOT_RELOAD) {
  delete require.cache[contextServicePath];
}

module.exports = require('./runtimeV2/context/service');
