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
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function buildPrivateMessage(messageId, rawText) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'allowed_user',
    message_id: messageId,
    raw_message: rawText,
    message: rawText,
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'allowed_user',
      nickname: 'allowed_user'
    }
  };
}

function buildDirectRoute(rawText = '') {
  const text = String(rawText || '').trim();
  return {
    topRouteType: 'direct_chat',
    cleanText: text,
    rawText: text,
    question: text,
    imageUrl: null,
    intent: {
      risk: 'low',
      toolNeed: ['none'],
      executionMode: 'immediate',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'none',
      domain: 'general',
      outputKind: 'answer',
      freshness: 'unknown'
    },
    meta: { reason: 'private-proactive-integration-test' }
  };
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-proactive-handler-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'allowed_user';
    clearProjectCache();

    const routeFlowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = routeFlowModule.createMessageRouteFlow;
    let formalDispatchCalls = 0;
    routeFlowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async () => {
        formalDispatchCalls += 1;
        return { replyText: '正常私聊回复', persistedReplyText: '正常私聊回复' };
      };
      return flow;
    };

    const activityCalls = [];
    const controlCalls = [];
    const registrations = [];
    const privateProactiveEngine = {
      recordObservedActivity(userId, activity) {
        activityCalls.push({ userId, activity });
      },
      handleControlCommand(text, context) {
        controlCalls.push({ text, context });
        if (text === '/主动私聊 状态') {
          return { handled: true, command: '状态', replyText: '主动私聊已开启。' };
        }
        return { handled: false, replyText: '' };
      },
      registerPrivateUser(userId, registration) {
        registrations.push({ userId, registration });
        return { registered: true };
      }
    };
    const sentPayloads = [];
    let intentCalls = 0;
    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const { handleIncomingMessage } = createMessageHandler({
      config,
      privateProactiveEngine,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => {
        intentCalls += 1;
        return buildDirectRoute(rawText);
      },
      generateSessionContextSummaryOverride: async () => ''
    });

    await handleIncomingMessage(buildPrivateMessage('control_status', '/主动私聊 状态'));
    assert.strictEqual(intentCalls, 0, '控制命令不能进入意图或模型链路');
    assert.strictEqual(formalDispatchCalls, 0);
    assert.strictEqual(registrations.length, 0, '控制命令回复不能触发首次登记');
    assert.strictEqual(sentPayloads.length, 1);
    assert.strictEqual(sentPayloads[0].action, 'send_private_msg');
    assert.strictEqual(sentPayloads[0].params.message, '主动私聊已开启。');

    await handleIncomingMessage(buildPrivateMessage('normal_private', '今天怎么样'));
    assert.strictEqual(intentCalls, 1);
    assert.strictEqual(formalDispatchCalls, 1);
    assert.strictEqual(registrations.length, 1, '成功正常私聊回复后应登记用户');
    assert.strictEqual(registrations[0].userId, 'allowed_user');
    assert.strictEqual(registrations[0].registration.notify, true);
    assert.strictEqual(activityCalls.length, 2);
    assert.ok(activityCalls.every((item) => item.activity.chatType === 'private'));
    assert.strictEqual(controlCalls.length, 2);
    assert.strictEqual(sentPayloads[1].params.message, '正常私聊回复');

    console.log('privateProactiveMessageHandler.test.js passed');
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
