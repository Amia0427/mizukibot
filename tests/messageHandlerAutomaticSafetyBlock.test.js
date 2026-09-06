'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const AUTOMATIC_BLOCK_DURATION_MS = 15 * 60 * 1000;
const AUTOMATIC_BLOCK_NOTICE = '您已被瑞希临时封禁，请十五分钟后再来';
const AUTOMATIC_BLOCK_SOURCE = 'automatic_safety';

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

function buildMessage({
  userId = 'normal_user',
  messageId,
  chatType = 'private',
  direction = 'none',
  text = '测试消息'
}) {
  const group = chatType === 'group';
  const segments = [];
  let rawMessage = text;
  if (direction === 'at') {
    segments.push({ type: 'at', data: { qq: 'bot_test' } });
    rawMessage = `[CQ:at,qq=bot_test] ${text}`;
  } else if (direction === 'reply') {
    segments.push({ type: 'reply', data: { id: `reply_${messageId}` } });
    rawMessage = `[CQ:reply,id=reply_${messageId}] ${text}`;
  }
  segments.push({ type: 'text', data: { text } });

  return {
    post_type: 'message',
    message_type: chatType,
    self_id: 'bot_test',
    user_id: userId,
    ...(group ? { group_id: 'group_test' } : {}),
    message_id: messageId,
    raw_message: rawMessage,
    message: segments,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: userId },
    __testDirection: direction
  };
}

function createReviewer({ decision = { blocked: false } } = {}) {
  const calls = {
    prepare: [],
    directed: [],
    review: []
  };
  return {
    calls,
    async prepareEntry(msg, context) {
      const preparedEntry = {
        messageId: String(msg.message_id || ''),
        direction: msg.__testDirection,
        text: String(msg.raw_message || '')
      };
      calls.prepare.push({ msg, context, preparedEntry });
      return preparedEntry;
    },
    isBotConversation(context) {
      calls.directed.push(context);
      const entry = context?.entry || {};
      return entry.mentionedBot === true
        || new Set(['at', 'reply', 'cue']).has(String(entry.direction || ''))
        || /瑞希/.test(String(entry.text || ''));
    },
    async review(context) {
      calls.review.push(context);
      return typeof decision === 'function' ? decision(context) : decision;
    }
  };
}

function createStore(initialBlock = null) {
  let activeBlock = initialBlock;
  const calls = {
    get: [],
    block: []
  };
  return {
    calls,
    get activeBlock() {
      return activeBlock;
    },
    set activeBlock(value) {
      activeBlock = value;
    },
    getActiveBlock(userId) {
      calls.get.push(String(userId || ''));
      if (activeBlock?.expiresAt > 0 && activeBlock.expiresAt <= Date.now()) return null;
      return activeBlock;
    },
    blockUser(input) {
      calls.block.push(input);
      activeBlock = {
        userId: input.userId,
        expiresAt: input.now + input.durationMs,
        blockedBy: input.blockedBy,
        blockSource: input.blockSource,
        reasonCode: input.reasonCode
      };
      return activeBlock;
    },
    unblockUser() {
      activeBlock = null;
      return { removed: true };
    }
  };
}

function createPreprocessor() {
  const calls = [];
  return {
    calls,
    async handleMessage(msg, context) {
      calls.push({ msg, context });
      return { mode: 'deferred' };
    }
  };
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const originalLoad = Module._load;
  const originalNow = Date.now;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-automatic-safety-handler-'));
  let currentStore = createStore();
  let currentPreprocessor = createPreprocessor();
  let defaultReviewer = createReviewer();
  let reviewerFactoryCalls = 0;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ADMIN_USER_IDS = 'admin_user';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'true';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.LAZY_COORDINATOR_INIT_ENABLED = 'true';
    clearProjectCache();

    const continuousMessagePreprocessor = require('../core/continuousMessagePreprocessor');
    const storeProxy = {
      getActiveBlock: (...args) => currentStore.getActiveBlock(...args),
      blockUser: (...args) => currentStore.blockUser(...args),
      unblockUser: (...args) => currentStore.unblockUser(...args)
    };
    Module._load = function mockedLoad(request, parent, isMain) {
      const parentFile = String(parent?.filename || '');
      if (parentFile.endsWith(`${path.sep}messageHandler.runtime.js`)) {
        if (request === './inboundUserSafety') {
          return {
            AUTOMATIC_BLOCK_DURATION_MS,
            AUTOMATIC_BLOCK_NOTICE,
            AUTOMATIC_BLOCK_SOURCE,
            createInboundUserSafetyReviewer() {
              reviewerFactoryCalls += 1;
              return defaultReviewer;
            }
          };
        }
        if (request === '../utils/userBlockStore') return storeProxy;
        if (request === './continuousMessagePreprocessor') {
          return {
            ...continuousMessagePreprocessor,
            createContinuousMessagePreprocessor: () => currentPreprocessor
          };
        }
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    function createHarness({ reviewer = createReviewer(), store = createStore() } = {}) {
      currentStore = store;
      currentPreprocessor = createPreprocessor();
      const sent = [];
      const downstream = { activity: 0, route: 0 };
      const handler = createMessageHandler({
        config,
        inboundUserSafetyReviewerOverride: reviewer,
        privateProactiveEngine: {
          recordObservedActivity() {
            downstream.activity += 1;
          }
        },
        detectIntentHybridOverride: async () => {
          downstream.route += 1;
          throw new Error('automatic safety block reached route resolver');
        },
        sendWithRetry: async (payload) => {
          sent.push(payload);
          return true;
        }
      });
      return { handler, reviewer, store, preprocessor: currentPreprocessor, sent, downstream };
    }

    currentPreprocessor = createPreprocessor();
    createMessageHandler({ config, sendWithRetry: async () => true });
    assert.strictEqual(reviewerFactoryCalls, 1, 'handler should create one default safety reviewer');

    const admin = createHarness();
    await admin.handler.handleIncomingMessage(buildMessage({
      userId: 'admin_user',
      messageId: 'admin_bypass',
      chatType: 'group',
      direction: 'at'
    }));
    assert.strictEqual(admin.store.calls.get.length, 0, 'admin should not query user blocks');
    assert.strictEqual(admin.reviewer.calls.prepare.length, 0, 'admin should not prepare safety input');
    assert.strictEqual(admin.reviewer.calls.directed.length, 0, 'admin should not run direction checks');
    assert.strictEqual(admin.reviewer.calls.review.length, 0, 'admin should not run safety review');
    assert.strictEqual(admin.preprocessor.calls.length, 1, 'admin should continue to normal downstream flow');
    assert.strictEqual(admin.preprocessor.calls[0].context.preparedEntry, undefined);

    const privateReviewer = createReviewer({
      decision: { blocked: true, reasonCode: 'political', severity: 'high', windowSize: 1 }
    });
    const privateHit = createHarness({ reviewer: privateReviewer });
    await privateHit.handler.handleIncomingMessage(buildMessage({
      messageId: 'private_hit',
      text: '触发审核'
    }));
    assert.strictEqual(privateHit.reviewer.calls.prepare.length, 1);
    assert.strictEqual(privateHit.reviewer.calls.review.length, 1);
    assert.strictEqual(privateHit.store.calls.get.length, 2, 'review hit should recheck the block before writing');
    assert.strictEqual(privateHit.store.calls.block.length, 1);
    assert.deepStrictEqual(privateHit.store.calls.block[0], {
      userId: 'normal_user',
      durationMs: AUTOMATIC_BLOCK_DURATION_MS,
      blockedBy: 'system',
      blockSource: AUTOMATIC_BLOCK_SOURCE,
      reasonCode: 'political',
      now: privateHit.store.calls.block[0].now
    });
    assert.strictEqual(privateHit.sent.length, 1);
    assert.strictEqual(privateHit.sent[0].action, 'send_private_msg');
    assert.strictEqual(privateHit.sent[0].params.message, AUTOMATIC_BLOCK_NOTICE);
    assert.strictEqual(privateHit.downstream.activity, 0);
    assert.strictEqual(privateHit.preprocessor.calls.length, 0);
    assert.strictEqual(privateHit.downstream.route, 0);

    for (const direction of ['at', 'reply', 'cue']) {
      const reviewer = createReviewer({
        decision: { blocked: true, reasonCode: 'malicious', severity: 'high', windowSize: 1 }
      });
      const harness = createHarness({ reviewer });
      await harness.handler.handleIncomingMessage(buildMessage({
        messageId: `group_${direction}`,
        chatType: 'group',
        direction,
        text: direction === 'cue' ? '瑞希，看看这个' : '看看这个'
      }));
      assert.strictEqual(reviewer.calls.review.length, 1, `${direction} group message should be reviewed`);
      assert.strictEqual(harness.store.calls.block.length, 1);
      assert.strictEqual(harness.sent.length, 1);
      assert.strictEqual(harness.sent[0].action, 'send_group_msg');
      assert.ok(String(harness.sent[0].params.message).includes(`[CQ:at,qq=normal_user]`));
      assert.ok(String(harness.sent[0].params.message).includes(AUTOMATIC_BLOCK_NOTICE));
    }

    const undirected = createHarness();
    await undirected.handler.handleIncomingMessage(buildMessage({
      messageId: 'group_undirected',
      chatType: 'group',
      direction: 'none'
    }));
    assert.strictEqual(undirected.reviewer.calls.prepare.length, 1);
    assert.strictEqual(undirected.reviewer.calls.review.length, 0);
    assert.strictEqual(undirected.store.calls.block.length, 0);
    assert.strictEqual(undirected.sent.length, 0);
    assert.strictEqual(undirected.preprocessor.calls.length, 1);
    assert.strictEqual(
      undirected.preprocessor.calls[0].context.preparedEntry,
      undirected.reviewer.calls.prepare[0].preparedEntry
    );
    assert.strictEqual(
      undirected.preprocessor.calls[0].context.preparedEntry.messageId,
      'group_undirected'
    );

    const automaticStore = createStore({
      userId: 'normal_user',
      expiresAt: Date.now() + AUTOMATIC_BLOCK_DURATION_MS,
      blockedBy: 'system',
      blockSource: AUTOMATIC_BLOCK_SOURCE,
      reasonCode: 'political'
    });
    const automatic = createHarness({ store: automaticStore });
    await automatic.handler.handleIncomingMessage(buildMessage({ messageId: 'automatic_1' }));
    await automatic.handler.handleIncomingMessage(buildMessage({ messageId: 'automatic_2' }));
    assert.strictEqual(automatic.sent.length, 2, 'each directed message should receive the automatic block notice');
    assert.strictEqual(automatic.store.calls.block.length, 0, 'active automatic blocks must not be extended');
    assert.strictEqual(automatic.reviewer.calls.prepare.length, 0);
    assert.strictEqual(automatic.downstream.activity, 0);
    assert.strictEqual(automatic.preprocessor.calls.length, 0);

    const automaticGroup = createHarness({
      store: createStore({
        userId: 'normal_user',
        expiresAt: Date.now() + AUTOMATIC_BLOCK_DURATION_MS,
        blockedBy: 'system',
        blockSource: AUTOMATIC_BLOCK_SOURCE,
        reasonCode: 'political'
      })
    });
    await automaticGroup.handler.handleIncomingMessage(buildMessage({
      messageId: 'automatic_group_at',
      chatType: 'group',
      direction: 'at'
    }));
    assert.strictEqual(automaticGroup.sent.length, 1);
    assert.ok(String(automaticGroup.sent[0].params.message).includes('[CQ:at,qq=normal_user]'));
    assert.strictEqual(automaticGroup.reviewer.calls.prepare.length, 1);
    assert.strictEqual(automaticGroup.reviewer.calls.review.length, 0);
    assert.strictEqual(automaticGroup.store.calls.block.length, 0);

    const automaticReply = createHarness({
      store: createStore({
        userId: 'normal_user',
        expiresAt: Date.now() + AUTOMATIC_BLOCK_DURATION_MS,
        blockedBy: 'system',
        blockSource: AUTOMATIC_BLOCK_SOURCE,
        reasonCode: 'political'
      })
    });
    await automaticReply.handler.handleIncomingMessage(buildMessage({
      messageId: 'automatic_group_reply',
      chatType: 'group',
      direction: 'reply'
    }));
    assert.strictEqual(automaticReply.sent.length, 1, 'blocked replies to the bot should receive the notice');
    assert.strictEqual(automaticReply.reviewer.calls.prepare.length, 1);
    assert.strictEqual(automaticReply.reviewer.calls.review.length, 0);
    assert.strictEqual(automaticReply.preprocessor.calls.length, 0);

    const undirectedAutomatic = createHarness({
      store: createStore({
        userId: 'normal_user',
        expiresAt: Date.now() + AUTOMATIC_BLOCK_DURATION_MS,
        blockedBy: 'system',
        blockSource: AUTOMATIC_BLOCK_SOURCE,
        reasonCode: 'political'
      })
    });
    await undirectedAutomatic.handler.handleIncomingMessage(buildMessage({
      messageId: 'automatic_group_undirected',
      chatType: 'group',
      direction: 'none'
    }));
    assert.strictEqual(undirectedAutomatic.sent.length, 0, 'undirected blocked group messages should stay silent');
    assert.strictEqual(undirectedAutomatic.reviewer.calls.prepare.length, 1);
    assert.strictEqual(undirectedAutomatic.reviewer.calls.review.length, 0);
    assert.strictEqual(undirectedAutomatic.preprocessor.calls.length, 0, 'all automatic blocks should stop downstream work');

    const manual = createHarness({
      store: createStore({
        userId: 'normal_user',
        expiresAt: 0,
        blockedBy: 'admin_user',
        blockSource: 'manual',
        reasonCode: ''
      })
    });
    await manual.handler.handleIncomingMessage(buildMessage({ messageId: 'manual_block' }));
    assert.strictEqual(manual.sent.length, 0, 'manual blocks should remain silent');
    assert.strictEqual(manual.reviewer.calls.prepare.length, 0);
    assert.strictEqual(manual.preprocessor.calls.length, 0);

    const raceStore = createStore();
    const raceManualBlock = {
      userId: 'normal_user',
      expiresAt: 0,
      blockedBy: 'admin_user',
      blockSource: 'manual',
      reasonCode: ''
    };
    raceStore.getActiveBlock = function getActiveBlock(userId) {
      this.calls.get.push(String(userId || ''));
      return this.calls.get.length === 1 ? null : raceManualBlock;
    };
    const manualRace = createHarness({
      store: raceStore,
      reviewer: createReviewer({
        decision: { blocked: true, reasonCode: 'political', severity: 'high', windowSize: 1 }
      })
    });
    await manualRace.handler.handleIncomingMessage(buildMessage({ messageId: 'manual_race' }));
    assert.strictEqual(manualRace.store.calls.block.length, 0, 'second block check should preserve a manual block');
    assert.strictEqual(manualRace.sent.length, 0, 'manual block found during the recheck should stay silent');
    assert.strictEqual(manualRace.preprocessor.calls.length, 0);

    let now = 10_000;
    Date.now = () => now;
    const expiringStore = createStore({
      userId: 'normal_user',
      expiresAt: now + 1_000,
      blockedBy: 'system',
      blockSource: AUTOMATIC_BLOCK_SOURCE,
      reasonCode: 'violent_threat'
    });
    const expiring = createHarness({ store: expiringStore });
    await expiring.handler.handleIncomingMessage(buildMessage({ messageId: 'before_expiry' }));
    now += 1_000;
    await expiring.handler.handleIncomingMessage(buildMessage({ messageId: 'after_expiry' }));
    assert.strictEqual(expiring.sent.length, 1, 'expired block should stop sending the block notice');
    assert.strictEqual(expiring.reviewer.calls.prepare.length, 1, 'expired user should return to safety review');
    assert.strictEqual(expiring.preprocessor.calls.length, 1, 'expired user should return to downstream flow');
    assert.strictEqual(
      expiring.preprocessor.calls[0].context.preparedEntry.messageId,
      'after_expiry'
    );

    console.log('messageHandlerAutomaticSafetyBlock.test.js passed');
  } finally {
    Date.now = originalNow;
    Module._load = originalLoad;
    restoreEnv(envSnapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
