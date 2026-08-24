const assert = require('assert');
const path = require('path');

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  const listenersBefore = new Map([
    ['beforeExit', new Set(process.listeners('beforeExit'))],
    ['exit', new Set(process.listeners('exit'))],
    ['SIGINT', new Set(process.listeners('SIGINT'))],
    ['SIGTERM', new Set(process.listeners('SIGTERM'))],
    ['SIGBREAK', new Set(process.listeners('SIGBREAK'))],
    ['SIGHUP', new Set(process.listeners('SIGHUP'))],
    ['mizuki:restartScheduled', new Set(process.listeners('mizuki:restartScheduled'))]
  ]);

  try {
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.FOLLOWER_DIRECT_DISPATCH_ENABLED = 'false';
    process.env.FOLLOWER_RULE_ENABLED = 'false';
    process.env.MESSAGE_INGRESS_ASYNC_ENABLED = 'true';
    process.env.TICK_ENGINE_ENABLED = 'false';
    process.env.SCHEDULER_RUNTIME_ENABLED = 'false';
    process.env.POST_REPLY_WORKER_INLINE = 'false';

    const { __test } = require('../index');
    const enqueued = [];
    __test.setMessageIngressDispatcherForTest({
      async dispatch(message, meta) {
        enqueued.push({ message, meta, waited: true });
      },
      enqueue(message, meta) {
        enqueued.push({ message, meta });
      }
    });

    const directMessage = { post_type: 'message', message_id: 'direct_1' };
    assert.strictEqual(await __test.acceptIncomingMessage(directMessage, 'direct_test'), true);
    assert.deepStrictEqual(enqueued[0], {
      message: directMessage,
      meta: { source: 'direct_test' }
    });

    await __test.acceptIncomingMessage(directMessage, 'waited_test', { waitForCompletion: true });
    assert.deepStrictEqual(enqueued[1], {
      message: directMessage,
      meta: { source: 'waited_test' },
      waited: true
    });

    const napcatMessage = { post_type: 'message', message_id: 'napcat_1' };
    assert.strictEqual(await __test.acceptNapCatIncomingMessage(napcatMessage, 'napcat_ws', () => false), true);
    assert.deepStrictEqual(enqueued[2], {
      message: napcatMessage,
      meta: { source: 'napcat_ws' }
    });
  } finally {
    for (const [eventName, listeners] of listenersBefore) {
      for (const listener of process.listeners(eventName)) {
        if (!listeners.has(listener)) process.removeListener(eventName, listener);
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey.startsWith(projectRoot)) delete require.cache[cacheKey];
    }
  }

  console.log('messageIngressAsyncEntrypointSource.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
