const assert = require('assert');
const path = require('path');

module.exports = (() => {
  const { createRuntime } = require('../api/runtimeV2/host');
  const { withSessionContextBatch } = require('../utils/shortTermSessionStore');
  let persistDependencies = null;

  createRuntime({
    storeOptions: {
      checkpointDir: path.resolve(__dirname, '..', 'tmp', 'tests', 'runtime-host-wiring', 'checkpoints'),
      eventDir: path.resolve(__dirname, '..', 'tmp', 'tests', 'runtime-host-wiring', 'events')
    },
    createPersistNodeOverride(dependencies) {
      persistDependencies = dependencies;
      return async (state) => state;
    }
  });

  assert.ok(persistDependencies, 'runtime host should create the persist node');
  assert.strictEqual(persistDependencies.withSessionContextBatch, withSessionContextBatch);
  assert.strictEqual(typeof persistDependencies.appendShortTermHistory, 'function');

  console.log('runtimeHostShortTermBatchWiring.test.js passed');
})();
