const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createMessageIngressDispatcher } = require('../core/messageIngressDispatcher');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-napcat-ws-smoke-'));
  const wsServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  const beforeExitListenersBeforeRequire = new Set(process.listeners('beforeExit'));
  const exitListenersBeforeRequire = new Set(process.listeners('exit'));
  const signalListenersBeforeRequire = {
    SIGINT: new Set(process.listeners('SIGINT')),
    SIGTERM: new Set(process.listeners('SIGTERM')),
    SIGBREAK: new Set(process.listeners('SIGBREAK')),
    SIGHUP: new Set(process.listeners('SIGHUP')),
    'mizuki:restartScheduled': new Set(process.listeners('mizuki:restartScheduled'))
  };
  let indexTest = null;
  let client = null;

  try {
    await new Promise((resolve) => wsServer.once('listening', resolve));
    const address = wsServer.address();

    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';
    process.env.DATA_DIR = path.join(tempRoot, 'data');
    process.env.NAPCAT_WS_URL = `ws://127.0.0.1:${address.port}`;
    process.env.NAPCAT_WS_TOKEN = '';
    process.env.FOLLOWER_DIRECT_DISPATCH_ENABLED = 'false';
    process.env.FOLLOWER_RULE_ENABLED = 'false';
    process.env.MESSAGE_INGRESS_ASYNC_ENABLED = 'true';
    process.env.TICK_ENGINE_ENABLED = 'false';
    process.env.SCHEDULER_RUNTIME_ENABLED = 'false';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    clearProjectCache();

    const { __test } = require('../index');
    indexTest = __test;

    const handled = [];
    const handledDeferred = createDeferred();
    const dispatcher = createMessageIngressDispatcher({
      maxActive: 1,
      maxQueueLength: 4,
      handleMessage: async (msg, meta) => {
        handled.push({ msg, meta });
        handledDeferred.resolve();
      }
    });
    __test.setMessageIngressDispatcherForTest(dispatcher);

    const connected = new Promise((resolve) => {
      wsServer.once('connection', (socket) => {
        client = socket;
        resolve(socket);
      });
    });
    __test.connectNapCat();
    const socket = await withTimeout(connected, 2000, 'fake NapCat websocket connection');
    socket.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      message_id: 26062601,
      user_id: 10001,
      raw_message: 'napcat ws smoke'
    }));

    await withTimeout(handledDeferred.promise, 2000, 'napcat websocket ingress dispatch');
    await dispatcher.waitForIdle(2000);

    assert.strictEqual(handled.length, 1);
    assert.strictEqual(handled[0].meta.source, 'napcat_ws');
    assert.strictEqual(handled[0].msg.message_id, 26062601);

    await dispatcher.stop({ drain: true, timeoutMs: 2000 });
    __test.setMessageIngressDispatcherForTest(null);
    __test.stopNapCatWebSocketForTest();

    console.log('napcatWsIngressSmoke.test.js passed');
  } finally {
    if (indexTest) {
      indexTest.stopNapCatWebSocketForTest();
      indexTest.setMessageIngressDispatcherForTest(null);
    }
    if (client && client.readyState !== WebSocket.CLOSED) {
      client.terminate();
    }
    for (const socket of wsServer.clients) {
      socket.terminate();
    }
    await closeServer(wsServer).catch(() => {});
    for (const listener of process.listeners('exit')) {
      if (!exitListenersBeforeRequire.has(listener)) process.removeListener('exit', listener);
    }
    for (const listener of process.listeners('beforeExit')) {
      if (!beforeExitListenersBeforeRequire.has(listener)) process.removeListener('beforeExit', listener);
    }
    for (const [eventName, previous] of Object.entries(signalListenersBeforeRequire)) {
      for (const listener of process.listeners(eventName)) {
        if (!previous.has(listener)) process.removeListener(eventName, listener);
      }
    }
    restoreEnv(snapshot);
    clearProjectCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
