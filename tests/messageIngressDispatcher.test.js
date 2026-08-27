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

  const dispatched = createMessageIngressDispatcher({
    handleMessage: async (msg) => `done:${msg.id}`
  });
  assert.strictEqual(await dispatched.dispatch({ id: 'waited' }), 'done:waited');
  await dispatched.stop({ drain: true, timeoutMs: 1000 });

  const noDrop = createMessageIngressDispatcher({
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
  assert.strictEqual(noDrop.enqueue({ id: 1 }), true);
  await delay(0);
  assert.strictEqual(noDrop.enqueue({ id: 2 }), true);
  assert.strictEqual(noDrop.enqueue({ id: 3 }), true, 'messages beyond the legacy queue limit should keep waiting');
  const fourth = noDrop.dispatch({ id: 4 });
  await noDrop.stop({ drain: true, timeoutMs: 1000 });
  await fourth;
  assert.strictEqual(noDrop.getSnapshot().completed, 4);
  assert.strictEqual(noDrop.getSnapshot().dropped, 0);

  const stopping = createMessageIngressDispatcher({
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
  assert.strictEqual(stopping.enqueue({ id: 1 }), true);
  await delay(0);
  const discarded = [2, 3, 4].map((id) => assert.rejects(
    stopping.dispatch({ id }),
    (error) => error?.code === 'MESSAGE_INGRESS_DISCARDED'
  ));
  await stopping.stop({ drain: false });
  await Promise.all(discarded);
  assert.strictEqual(stopping.getSnapshot().dropped, 3, 'stop without drain should count discarded queued work');

  console.log('messageIngressDispatcher.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
