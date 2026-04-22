const modelServicePath = require.resolve('./runtimeV2/model/service');
const config = require('../config');

if (config.AGENT_DEV_HOT_RELOAD) {
  delete require.cache[modelServicePath];
}

module.exports = require('./runtimeV2/model/service');
