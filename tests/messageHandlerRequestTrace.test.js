const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function readJsonLines(filePath = '') {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildPrivateMessage() {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_trace',
    user_id: 'trace_user',
    message_id: 'trace_msg_1',
    raw_message: 'hello',
    message: 'hello',
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'trace_user',
      nickname: 'trace_user'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-message-trace-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_trace';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '';

    clearProjectCache();

    const { createMessageHandler } = require('../core/messageHandler');
    const {
      flushRequestTraceEventsSync,
      resetRequestTraceStateForTests
    } = require('../utils/requestTrace');

    resetRequestTraceStateForTests();

    const { handleIncomingMessage } = createMessageHandler({
      config: require('../config'),
      sendWithRetry: async () => true
    });

    await handleIncomingMessage({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      time: Math.floor(Date.now() / 1000)
    });
    await handleIncomingMessage({});
    flushRequestTraceEventsSync();

    const traceFile = path.join(tempDataDir, 'request-trace.ndjson');
    assert.ok(
      !readJsonLines(traceFile).some((event) => event.stage === 'handle_incoming_start'),
      'heartbeat and empty packets must not create message ingress trace rows'
    );

    await handleIncomingMessage(buildPrivateMessage());
    flushRequestTraceEventsSync();

    const traceEvents = readJsonLines(traceFile);
    const startEvent = traceEvents.find((event) => event.stage === 'handle_incoming_start');
    assert.ok(startEvent, 'formal private messages should still create ingress trace rows');
    assert.strictEqual(startEvent.messageId, 'trace_msg_1');
    assert.strictEqual(startEvent.userId, 'trace_user');
    assert.strictEqual(startEvent.chatType, 'private');

    console.log('messageHandlerRequestTrace.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
