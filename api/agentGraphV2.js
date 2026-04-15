const hostPath = require.resolve('./runtimeV2/host');
delete require.cache[hostPath];

function getHost() {
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

async function runPersistInBackgroundFromCheckpoint(threadId = '') {
  return getHost().getRuntime().runPersistInBackgroundFromCheckpoint(threadId);
}

module.exports = {
  askAIByGraphV2,
  createRuntime,
  createInitialState,
  getRuntime,
  runPersistInBackgroundFromCheckpoint
};
