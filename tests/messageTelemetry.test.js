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
const {
  createCheckpointStore,
  resolveThreadId
} = require('../utils/langgraphV2Store');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');

assert.strictEqual(getRawMessageTimestampMs({ time: 123 }), 123000);

const logFile = path.join(tempDir, 'timing.jsonl');
appendInboundTimingLog(logFile, true, { stage: 'start', messageId: 'm1' });
const events = [];
const persistedThreadIds = [];
const checkpointStore = createCheckpointStore({
  checkpointDir: path.join(tempDir, 'langgraph_v2_checkpoints'),
  eventDir: path.join(tempDir, 'langgraph_v2_events')
});
const imageRouteMeta = {
  userId: 'u2',
  groupId: 'g2',
  chatType: 'group'
};
const expectedImageThreadId = resolveThreadId({
  userId: 'u2',
  routePolicyKey: 'transform/vision-summary',
  reviewMode: '',
  routeMeta: imageRouteMeta,
  sessionKey: resolveShortTermSessionKey('u2', imageRouteMeta),
  imageUrl: 'cached-image://current',
  options: {
    routeMeta: imageRouteMeta
  }
});
checkpointStore.saveCheckpoint(expectedImageThreadId, {
  status: 'running',
  node: 'direct_reply',
  updatedAt: Date.now() - (60 * 60 * 1000),
  state: {
    thread: {
      threadId: expectedImageThreadId
    }
  }
});
const coordinator = createMessageTelemetryCoordinator({
  buildReplyTelemetry: () => ({
    onEvent(event) {
      events.push(event);
    }
  }),
  runPersistInBackgroundFromCheckpoint: async (threadId) => {
    persistedThreadIds.push(threadId);
    const checkpoint = checkpointStore.loadCheckpoint(threadId);
    if (checkpoint) {
      checkpointStore.saveCheckpoint(threadId, {
        ...checkpoint,
        status: 'completed',
        node: 'persist'
      });
    }
    return true;
  }
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

coordinator.maybeRunDeferredPersist({
  replyOptions: {
    deferPersist: true,
    routePolicyKey: 'transform/vision-summary',
    topRouteType: 'direct_chat',
    imageUrl: 'cached-image://current',
    routeMeta: imageRouteMeta
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
      assert.ok(persistedThreadIds.includes(expectedImageThreadId));
      assert.strictEqual(checkpointStore.loadCheckpoint(expectedImageThreadId).status, 'completed');
      assert.ok(events.some((event) => (
        event.type === 'persist_background_success'
        && event.threadId === expectedImageThreadId
      )));
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
