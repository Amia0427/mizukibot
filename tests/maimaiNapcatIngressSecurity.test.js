const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache(projectRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-maimai-ingress-'));
  const listenersBefore = new Map([
    ['beforeExit', new Set(process.listeners('beforeExit'))],
    ['exit', new Set(process.listeners('exit'))],
    ['SIGINT', new Set(process.listeners('SIGINT'))],
    ['SIGTERM', new Set(process.listeners('SIGTERM'))],
    ['SIGBREAK', new Set(process.listeners('SIGBREAK'))],
    ['SIGHUP', new Set(process.listeners('SIGHUP'))],
    ['mizuki:restartScheduled', new Set(process.listeners('mizuki:restartScheduled'))]
  ]);
  const sentinel = 'MAIMAI_TOKEN_SENTINEL_20260804';
  const consoleLines = [];
  const originalConsoleError = console.error;
  let actionClient = null;
  let originalCallAction = null;
  let platformRuntime = null;

  try {
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';
    process.env.DATA_DIR = path.join(tempRoot, 'data');
    process.env.MAIMAI_ENABLED = 'false';
    process.env.FOLLOWER_PACKET_LOG_ENABLED = 'true';
    process.env.FOLLOWER_NAPCAT_LOG_PATH = path.join(tempRoot, 'napcat-packets.jsonl');
    process.env.FOLLOWER_DIRECT_DISPATCH_ENABLED = 'true';
    process.env.MESSAGE_INGRESS_ASYNC_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.SCHEDULER_RUNTIME_ENABLED = 'false';
    process.env.TICK_ENGINE_ENABLED = 'false';
    clearProjectCache(projectRoot);

    actionClient = require('../api/napcatActionClient').getNapCatActionClient();
    originalCallAction = actionClient.callAction;
    const outbound = [];
    actionClient.callAction = async (action, params) => { outbound.push({ action, params }); return { ok: true }; };
    console.error = (...args) => { consoleLines.push(args.map(String).join(' ')); };

    const { __test } = require('../index');
    platformRuntime = __test.platformRuntime;
    const dispatched = [];
    __test.setMessageIngressDispatcherForTest({ enqueue: (message) => dispatched.push(message) });
    const accepted = await __test.acceptNapCatIncomingMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 'maimai_bind_security',
      user_id: '10001',
      raw_message: `/mai bind ${sentinel}`
    }, 'napcat_ws');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(accepted, false);
    assert.strictEqual(dispatched.length, 0);
    assert.ok(outbound.length > 0);
    assert.ok(!JSON.stringify(outbound).includes(sentinel));
    assert.ok(!consoleLines.join('\n').includes(sentinel));
    const packetLog = process.env.FOLLOWER_NAPCAT_LOG_PATH;
    assert.ok(!fs.existsSync(packetLog) || !fs.readFileSync(packetLog, 'utf8').includes(sentinel));
    console.log('maimaiNapcatIngressSecurity.test.js passed');
  } finally {
    console.error = originalConsoleError;
    if (actionClient && originalCallAction) actionClient.callAction = originalCallAction;
    for (const [eventName, listeners] of listenersBefore) {
      for (const listener of process.listeners(eventName)) {
        if (!listeners.has(listener)) process.removeListener(eventName, listener);
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    platformRuntime?.closeStores();
    require('../utils/sqliteRuntime').closeLoadedSqliteConnections();
    clearProjectCache(projectRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
