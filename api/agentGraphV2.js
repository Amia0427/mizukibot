const hostPath = require.resolve('./runtimeV2/host');
const config = require('../config');

if (config.AGENT_DEV_HOT_RELOAD) {
  delete require.cache[hostPath];
}

function getHost() {
  if (config.AGENT_DEV_HOT_RELOAD) {
    delete require.cache[hostPath];
  }
  return require('./runtimeV2/host');
}

async function askAIByGraphV2(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return getHost().askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

function createRuntime(options = {}) {
  return getHost().createRuntime(options);
}

function createInitialState(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return getHost().createInitialState(question, userInfo, userId, customPrompt, imageUrl, options);
}

function getRuntime() {
  return getHost().getRuntime();
}

function resetRuntime() {
  return getHost().resetRuntime();
}

async function runPersistInBackgroundFromCheckpoint(threadId = '') {
  return getHost().getRuntime().runPersistInBackgroundFromCheckpoint(threadId);
}

module.exports = {
  askAIByGraphV2,
  createRuntime,
  createInitialState,
  getRuntime,
  resetRuntime,
  runPersistInBackgroundFromCheckpoint
};
