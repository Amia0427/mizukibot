const assert = require('assert');

const tickEngine = require('../core/tickEngine');

module.exports = (async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    scheduled.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};
  let tickCalls = 0;
  try {
    const runtime = tickEngine.startTickEngine(async () => 'unused', null, {
      legacyEnabled: false,
      companionRoomRuntime: { async tick() { tickCalls += 1; } }
    });
    assert.strictEqual(scheduled.length, 1);
    assert.ok(scheduled[0].delay >= 10000);
    await scheduled[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(tickCalls, 1);
    runtime.stop();
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
  console.log('companionRoomTickEngine.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
