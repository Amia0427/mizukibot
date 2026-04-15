const contextServicePath = require.resolve('./runtimeV2/context/service');
delete require.cache[contextServicePath];

module.exports = require('./runtimeV2/context/service');
