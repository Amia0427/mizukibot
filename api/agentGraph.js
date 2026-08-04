// Public shell only. Keep exports stable here, but route all runtime behavior
// through the facade/V2 host and keep compat helpers isolated from the shell.
const { askAIByGraph, askAIByGraphV1 } = require('./agentGraphFacade');
const { runPersistInBackgroundFromCheckpoint } = require('./agentGraphV2');

module.exports = {
  askAIByGraph,
  askAIByGraphV1,
  runPersistInBackgroundFromCheckpoint
};
