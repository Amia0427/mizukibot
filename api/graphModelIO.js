const modelServicePath = require.resolve('./runtimeV2/model/service');
delete require.cache[modelServicePath];

module.exports = require('./runtimeV2/model/service');
