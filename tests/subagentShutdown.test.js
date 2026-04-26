const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.SUBAGENT_BACKEND = 'command';
    process.env.SUBAGENT_COMMAND = 'fake-command';
    process.env.SUBAGENT_WORKDIR = 'D:/waifu';
    process.env.SUBAGENT_ARGS = JSON.stringify(['--message', '{message}']);
    process.env.SUBAGENT_COMMAND_MODE = 'spawn';
    process.env.SUBAGENT_TIMEOUT_MS = '1000';

    clearProjectCache();
    const executor = require('../api/subagentExecutor');
    const backend = require('../api/subagentBackends/commandBackend');

    let cancelCalled = false;
    backend.setCommandBackendTestHooks({
      createSpawnBridgeCall() {
        return {
          promise: new Promise((_resolve, reject) => {
            backend.__rejectForShutdownTest = reject;
          }),
          cancel() {
            cancelCalled = true;
            const error = new Error('cancelled by shutdown');
            error.code = 'SUBAGENT_CANCELLED';
            backend.__rejectForShutdownTest(error);
          }
        };
      }
    });

    const call = await executor.startSubagentBridgeCall(
      'long task',
      {},
      'user-1',
      null,
      null,
      {}
    );
    const shutdown = executor.shutdownSubagentExecutor('test_shutdown');
    assert.strictEqual(shutdown.cancelled, 1);
    assert.strictEqual(cancelCalled, true);

    await assert.rejects(call.promise, (error) => {
      return String(error?.code || '') === 'SUBAGENT_CANCELLED';
    });

    await assert.rejects(
      executor.startSubagentBridgeCall('after shutdown', {}, 'user-1'),
      (error) => String(error?.code || '') === 'SUBAGENT_SHUTTING_DOWN'
    );

    backend.setCommandBackendTestHooks({});
    console.log('subagentShutdown.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
