const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-telemetry-'));
process.env.DATA_DIR = tempDir;

const {
  appendInboundTimingLog,
  createMessageTelemetryCoordinator,
  getRawMessageTimestampMs
} = require('../core/messageTelemetry');

assert.strictEqual(getRawMessageTimestampMs({ time: 123 }), 123000);

const logFile = path.join(tempDir, 'timing.jsonl');
appendInboundTimingLog(logFile, true, { stage: 'start', messageId: 'm1' });
const events = [];
const coordinator = createMessageTelemetryCoordinator({
  buildReplyTelemetry: () => ({
    onEvent(event) {
      events.push(event);
    }
  }),
  runPersistInBackgroundFromCheckpoint: async () => true
});

coordinator.maybeRunDeferredPersist({
  replyOptions: {
    deferPersist: true,
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat',
    routeMeta: {
      userId: 'u1',
      groupId: 'g1',
      chatType: 'group'
    }
  }
});

module.exports = new Promise((resolve, reject) => {
  setTimeout(() => {
    try {
      const logged = fs.readFileSync(logFile, 'utf8');
      assert.ok(logged.includes('"stage":"start"'));
      assert.ok(logged.includes('"messageId":"m1"'));
      assert.ok(events.some((event) => event.type === 'persist_background_start'));
      assert.ok(events.some((event) => event.type === 'persist_background_success'));
      console.log('messageTelemetry.test.js passed');
      resolve();
    } catch (error) {
      reject(error);
    }
  }, 250);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
