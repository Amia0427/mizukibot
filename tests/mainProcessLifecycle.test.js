'use strict';

const assert = require('assert');

const { createMainProcessLifecycle } = require('../utils/mainProcessLifecycle');

module.exports = (async () => {
  const calls = [];
  let releaseStopAccepting;
  const stopAccepting = new Promise((resolve) => {
    releaseStopAccepting = resolve;
  });
  const exitCodes = [];
  const lifecycle = createMainProcessLifecycle({
    begin: async (context) => calls.push(`begin:${context.reason}`),
    stopAccepting: async () => {
      calls.push('stop_accepting:start');
      await stopAccepting;
      calls.push('stop_accepting:done');
    },
    stopRuntimes: async () => calls.push('stop_runtimes'),
    drainWorkers: async () => calls.push('drain_workers'),
    cleanupExternal: async () => calls.push('cleanup_external'),
    finalize: async () => calls.push('finalize'),
    complete: async (context) => calls.push(`complete:${context.exitCode}`),
    exit: (code) => exitCodes.push(code)
  });

  const first = lifecycle.drain({ reason: 'remote_restart_scheduled' });
  const second = lifecycle.drain({ reason: 'SIGTERM', exitProcess: true, exitCode: 143 });
  assert.strictEqual(first, second, 'concurrent drain requests should share one lifecycle promise');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(calls, [
    'begin:remote_restart_scheduled',
    'stop_accepting:start',
    'stop_runtimes',
    'drain_workers',
    'cleanup_external'
  ]);
  assert.deepStrictEqual(exitCodes, []);

  releaseStopAccepting();
  const result = await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(result.reason, 'remote_restart_scheduled');
  assert.deepStrictEqual(calls, [
    'begin:remote_restart_scheduled',
    'stop_accepting:start',
    'stop_runtimes',
    'drain_workers',
    'cleanup_external',
    'stop_accepting:done',
    'finalize',
    'complete:143'
  ]);
  assert.deepStrictEqual(exitCodes, [143], 'a later signal should exit after the shared drain completes');
  assert.deepStrictEqual(lifecycle.getSnapshot(), {
    state: 'stopped',
    reason: 'remote_restart_scheduled',
    exitRequested: true,
    exitCode: 143
  });

  console.log('mainProcessLifecycle.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
