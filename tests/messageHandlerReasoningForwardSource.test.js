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

function buildPrivateMessage(messageId, rawText = '你好') {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'user_1',
    message_id: messageId,
    raw_message: rawText,
    message: rawText,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 'user_1', nickname: 'user_1' }
  };
}

function buildDirectRoute(rawText = '') {
  return {
    topRouteType: 'direct_chat',
    cleanText: String(rawText || '').trim(),
    rawText: String(rawText || '').trim(),
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
    meta: { reason: 'reasoning-forward-behavior-test' }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-reasoning-forward-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'true';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';

    clearProjectCache();

    const events = [];
    const reasoningPayloads = [];
    const qqActionService = require('../api/qqActionService');
    qqActionService.sendReasoningForwardMessage = async (payload) => {
      events.push('reasoning-forward');
      reasoningPayloads.push(payload);
      return { success: true };
    };

    const normalFastReplyGate = require('../utils/normalFastReplyGate');
    normalFastReplyGate.buildNormalFastReplyDecision = ({ rawText }) => ({
      eligible: String(rawText || '').startsWith('fast'),
      text: String(rawText || '').trim(),
      reason: 'reasoning-forward-behavior-test'
    });
    const normalFastReplyRuntime = require('../core/normalFastReplyRuntime');
    normalFastReplyRuntime.runNormalFastReply = async ({ text }) => {
      if (String(text || '').includes('cleaned only')) {
        return {
          replyText: 'fast cleaned-only visible reply',
          persistedReplyText: 'fast cleaned-only visible reply',
          reasoningForwardText: 'fast cleaned-only persona reasoning'
        };
      }
      return {
        replyText: 'fast raw visible reply',
        persistedReplyText: 'fast raw visible reply',
        reasoningText: 'fast raw provider reasoning',
        reasoningForwardText: 'fast cleaned persona reasoning'
      };
    };

    const routeFlowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = routeFlowModule.createMessageRouteFlow;
    let dispatchCount = 0;
    routeFlowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return {
            replyText: '<think>hidden</think>visible reply',
            persistedReplyText: 'visible reply',
            reasoningText: 'raw provider reasoning',
            reasoningForwardText: 'cleaned persona reasoning'
          };
        }
        return {
          replyText: 'second visible reply',
          persistedReplyText: 'second visible reply',
          reasoningForwardText: 'cleaned-only reasoning'
        };
      };
      return flow;
    };

    const config = require('../config');
    const handlerModule = require('../core/messageHandler');
    assert.strictEqual(typeof handlerModule.createMessageHandler, 'function');
    const sentMessages = [];
    const { handleIncomingMessage } = handlerModule.createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        events.push('normal-reply');
        sentMessages.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    await handleIncomingMessage(buildPrivateMessage('reasoning_raw'));
    assert.deepStrictEqual(events.slice(0, 2), ['normal-reply', 'reasoning-forward']);
    assert.strictEqual(reasoningPayloads.length, 1);
    assert.strictEqual(reasoningPayloads[0].reasoningText, 'raw provider reasoning');
    assert.ok(!reasoningPayloads[0].reasoningText.includes('cleaned persona reasoning'));
    assert.ok(
      sentMessages.some((payload) => String(payload?.params?.message || '') === 'visible reply'),
      'the normal reply should be sanitized before sending'
    );

    await handleIncomingMessage(buildPrivateMessage('reasoning_cleaned_only'));
    assert.strictEqual(
      reasoningPayloads.length,
      1,
      'reasoningForwardText alone must not be treated as raw provider reasoning'
    );

    const fastEventStart = events.length;
    await handleIncomingMessage(buildPrivateMessage('fast_reasoning_raw', 'fast raw'));
    assert.deepStrictEqual(events.slice(fastEventStart, fastEventStart + 2), ['normal-reply', 'reasoning-forward']);
    assert.strictEqual(reasoningPayloads.length, 2);
    assert.strictEqual(reasoningPayloads[1].reasoningText, 'fast raw provider reasoning');
    assert.ok(!reasoningPayloads[1].reasoningText.includes('fast cleaned persona reasoning'));

    await handleIncomingMessage(buildPrivateMessage('fast_reasoning_cleaned_only', 'fast cleaned only'));
    assert.strictEqual(
      reasoningPayloads.length,
      2,
      'the fast path must not forward reasoningForwardText when raw reasoningText is absent'
    );
    assert.strictEqual(dispatchCount, 2, 'eligible fast replies should return before formal route dispatch');

    console.log('messageHandlerReasoningForwardSource.test.js passed');
  } finally {
    require('../utils/sqliteRuntime').closeLoadedSqliteConnections();
    restoreEnv(snapshot);
    clearProjectCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
