const assert = require('assert');

const { createMessageIngressDispatcher } = require('../core/messageIngressDispatcher');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  const events = [];
  const dispatcher = createMessageIngressDispatcher({
    maxActive: 2,
    maxQueueLength: 10,
    logger: {
      warn() {},
      error() {}
    },
    handleMessage: async (msg) => {
      events.push(`start:${msg.id}`);
      await delay(30);
      events.push(`end:${msg.id}`);
    }
  });

  assert.strictEqual(dispatcher.enqueue({ id: 'a' }, { source: 'test' }), true);
  assert.deepStrictEqual(events, [], 'enqueue should not run the handler synchronously');
  assert.strictEqual(dispatcher.enqueue({ id: 'b' }, { source: 'test' }), true);
  assert.strictEqual(dispatcher.enqueue({ id: 'c' }, { source: 'test' }), true);

  await dispatcher.stop({ drain: true, timeoutMs: 1000 });
  assert.deepStrictEqual(events.slice(0, 2).sort(), ['start:a', 'start:b']);
  assert.ok(
    events.indexOf('start:c') > Math.min(events.indexOf('end:a'), events.indexOf('end:b')),
    'third task should wait for an active slot'
  );
  for (const id of ['a', 'b', 'c']) {
    assert.ok(events.includes(`start:${id}`), `task ${id} should start`);
    assert.ok(events.includes(`end:${id}`), `task ${id} should finish`);
    assert.ok(events.indexOf(`start:${id}`) < events.indexOf(`end:${id}`), `task ${id} should finish after start`);
  }
  assert.strictEqual(dispatcher.getSnapshot().completed, 3);

  const full = createMessageIngressDispatcher({
    maxActive: 1,
    maxQueueLength: 1,
    logger: {
      warn() {},
      error() {}
    },
    handleMessage: async () => {
      await delay(50);
    }
  });
  assert.strictEqual(full.enqueue({ id: 1 }), true);
  await delay(0);
  assert.strictEqual(full.enqueue({ id: 2 }), true);
  assert.strictEqual(full.enqueue({ id: 3 }), false, 'queue full should drop without throwing');
  assert.strictEqual(full.getSnapshot().dropped, 1);
  await full.stop({ drain: false });
  assert.strictEqual(full.getSnapshot().dropped, 2, 'stop without drain should count discarded queued work');

  console.log('messageIngressDispatcher.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
