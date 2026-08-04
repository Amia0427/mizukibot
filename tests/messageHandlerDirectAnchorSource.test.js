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

function buildGroupMessage({ messageId, mentioned }) {
  const prefix = mentioned ? '[CQ:at,qq=bot_test] ' : '[CQ:reply,id=bot_reply_1] ';
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 'bot_test',
    user_id: 'user_1',
    group_id: 'group_1',
    message_id: messageId,
    raw_message: `${prefix}继续说`,
    message: `${prefix}继续说`,
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'user_1',
      nickname: 'user_1'
    }
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
    meta: {
      reason: 'direct-anchor-behavior-test'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-direct-anchor-'));
  const originalConsoleLog = console.log;
  const acceptedInbound = [];

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'group_1';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';

    console.log = (...args) => {
      if (args[0] === '[message] accepted inbound') acceptedInbound.push(args[1]);
      originalConsoleLog(...args);
    };

    clearProjectCache();

    const directedContextModule = require('../core/messageDirectedContext');
    directedContextModule.resolveMessageDirectedContext = async () => ({
      scene: 'reply_to_bot',
      addressee: { kind: 'bot', userId: 'bot_test' },
      quote: { messageId: 'bot_reply_1', senderId: 'bot_test', text: '上一条回复' },
      quotePriority: { enabled: true, mode: 'reply_anchor', quoteAnchoredText: '继续说' },
      signals: { hasReply: true }
    });

    const passiveModule = require('../core/passiveGroupAwareness');
    let passiveCalls = 0;
    passiveModule.handlePassiveGroupAwareness = async () => {
      passiveCalls += 1;
      return { handled: true, reason: 'behavior-test-passive' };
    };

    const routeFlowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = routeFlowModule.createMessageRouteFlow;
    let formalDispatchCalls = 0;
    routeFlowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async () => {
        formalDispatchCalls += 1;
        return { replyText: 'formal reply', persistedReplyText: 'formal reply' };
      };
      return flow;
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const sentPayloads = [];
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    await handleIncomingMessage(buildGroupMessage({ messageId: 'reply_without_at', mentioned: false }));
    assert.strictEqual(passiveCalls, 1, 'replying to a recent bot message without @ should stay in passive flow');
    assert.strictEqual(formalDispatchCalls, 0, 'reply-to-bot recency must not become a formal-route anchor');
    assert.strictEqual(sentPayloads.length, 0, 'passive flow owns any optional reply for an unmentioned group message');
    assert.strictEqual(acceptedInbound.length, 0, 'an unmentioned reply-to-bot message must not be logged as formally accepted');

    await handleIncomingMessage(buildGroupMessage({ messageId: 'explicit_at', mentioned: true }));
    assert.strictEqual(passiveCalls, 1, 'an explicit @ should bypass passive awareness');
    assert.strictEqual(formalDispatchCalls, 1, 'an explicit @ should enter the formal route');
    assert.deepStrictEqual(acceptedInbound.map((entry) => entry?.acceptedBy), ['at_bot']);
    assert.ok(
      sentPayloads.some((payload) => String(payload?.params?.message || '').includes('formal reply')),
      'the explicitly anchored message should send the formal reply'
    );

    console.log('messageHandlerDirectAnchorSource.test.js passed');
  } finally {
    console.log = originalConsoleLog;
    require('../utils/sqliteRuntime').closeLoadedSqliteConnections();
    restoreEnv(snapshot);
    clearProjectCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
