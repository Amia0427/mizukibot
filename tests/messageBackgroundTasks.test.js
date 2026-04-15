const assert = require('assert');

const { createMessageBackgroundTaskCoordinator } = require('../core/messageBackgroundTasks');

const sentReplies = [];
const taskStore = new Map();

const backgroundTaskRuntime = {
  startTask(payload) {
    const task = {
      id: `task_${taskStore.size + 1}`,
      ack_sent: false,
      followup_sent: false,
      ...payload
    };
    taskStore.set(task.id, task);
    return task;
  },
  attachController() {},
  markTaskRunning(taskId, stage) {
    const task = taskStore.get(taskId);
    task.stage = stage;
    task.status = 'running';
  },
  shouldContinue() {
    return true;
  },
  getTask(taskId) {
    return taskStore.get(taskId);
  },
  finalizeTask(taskId, patch) {
    Object.assign(taskStore.get(taskId), patch);
  },
  requestCancel(taskId, patch) {
    Object.assign(taskStore.get(taskId), patch);
    return true;
  },
  canEmitFollowup() {
    return true;
  },
  markFollowupSent(taskId, value) {
    taskStore.get(taskId).followup_sent = value;
  },
  markAckSent(taskId, value) {
    taskStore.get(taskId).ack_sent = value;
  }
};

const coordinator = createMessageBackgroundTaskCoordinator({
  config: {
    BACKGROUND_TASK_ACK_DELAY_MS: 20
  },
  buildSessionId: (senderId, { sessionChatId }) => `${senderId}:${sessionChatId}`,
  backgroundTaskRuntime,
  normalizeUserFacingReply: (text) => String(text || '').trim(),
  getEffectivePolicyKey: () => 'direct_chat/default',
  summarizeBackgroundReply: (text) => String(text || '').slice(0, 20),
  sendGroupReply: async (payload) => {
    sentReplies.push(payload);
    return true;
  },
  maybeSendMemeFollowup: async () => {},
  sendWithRetry: async () => true
});

module.exports = (async () => {
  const immediate = await coordinator.runBackgroundToolTask({
    route: { meta: {} },
    routeExecutionPlan: {
      executor: 'background_direct',
      topRouteType: 'direct_chat',
      allowTools: true
    },
    cleanText: 'task 1',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1',
    toolTaskOptions: {},
    executionHandleFactory: async () => ({
      promise: Promise.resolve('done now'),
      cancel() {}
    })
  });
  assert.strictEqual(immediate.backgroundHandled, false);
  assert.strictEqual(immediate.reply, 'done now');

  const delayed = await coordinator.runBackgroundToolTask({
    route: { meta: {} },
    routeExecutionPlan: {
      executor: 'background_direct',
      topRouteType: 'direct_chat',
      allowTools: true
    },
    cleanText: 'task 2',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1',
    toolTaskOptions: {},
    executionHandleFactory: async () => ({
      promise: new Promise((resolve) => setTimeout(() => resolve('done later'), 40)),
      cancel() {}
    })
  });
  assert.strictEqual(delayed.backgroundHandled, true);
  assert.ok(sentReplies.some((entry) => String(entry.replyText || '').includes('后台跑')));

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(sentReplies.some((entry) => String(entry.replyText || '').includes('done later')));

  console.log('messageBackgroundTasks.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
