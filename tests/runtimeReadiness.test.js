const assert = require('assert');

const { createRuntimeReadiness } = require('../utils/runtimeReadiness');

const readiness = createRuntimeReadiness({ now: () => 1000 });
assert.deepStrictEqual(readiness.getSnapshot(), {
  stage: 'starting',
  live: true,
  ready: false,
  reason: 'startup',
  changedAt: 1000
});

assert.strictEqual(readiness.markReady('startup_complete'), true);
assert.deepStrictEqual(readiness.getSnapshot(), {
  stage: 'ready',
  live: true,
  ready: true,
  reason: 'startup_complete',
  changedAt: 1000
});
assert.strictEqual(readiness.markReady('duplicate'), false);
assert.strictEqual(readiness.beginDrain('SIGTERM'), true);
assert.strictEqual(readiness.getSnapshot().stage, 'draining');
assert.strictEqual(readiness.getSnapshot().live, true);
assert.strictEqual(readiness.getSnapshot().ready, false);
assert.strictEqual(readiness.markReady('invalid_recovery'), false);
assert.strictEqual(readiness.markStopped('shutdown_complete'), true);
assert.deepStrictEqual(readiness.getSnapshot(), {
  stage: 'stopped',
  live: false,
  ready: false,
  reason: 'shutdown_complete',
  changedAt: 1000
});
assert.strictEqual(readiness.beginDrain('duplicate'), false);

const startupFailure = createRuntimeReadiness({ now: () => 2000 });
assert.strictEqual(startupFailure.beginDrain('startup_failed'), true);
assert.strictEqual(startupFailure.markStopped('exit'), true);

const platformReadiness = createRuntimeReadiness({
  now: () => 3000,
  detailsProvider: () => ({
    messageIngressReady: false,
    platforms: [{ platform: 'discord', status: 'degraded' }]
  })
});
platformReadiness.markReady();
assert.strictEqual(platformReadiness.getSnapshot().ready, false);
assert.strictEqual(platformReadiness.getSnapshot().platforms[0].platform, 'discord');

console.log('runtimeReadiness.test.js passed');
