const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-continuous-message-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED = 'false';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const {
  cheapParseMessageEntry,
  createContinuousMessagePreprocessor,
  isCommandBypass,
  resolveContinuousEntryDetails
} = require('../core/continuousMessagePreprocessor');

function isProjectModuleLoaded(relPath) {
  const abs = path.resolve(__dirname, '..', relPath);
  return Object.keys(require.cache).some((key) => key === abs);
}

function makeMessage({
  messageId,
  userId = 'u1',
  groupId = '',
  messageType = 'private',
  time = 1710000000,
  message = [],
  rawMessage = ''
} = {}) {
  return {
    message_id: String(messageId || ''),
    user_id: String(userId || ''),
    group_id: String(groupId || ''),
    message_type: messageType,
    time,
    message,
    raw_message: rawMessage
  };
}

async function testImageThenTextMergesIntoOneTurn() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 80,
    atBotDebounceMs: 80,
    privateDebounceMs: 80,
    maxHoldMs: 260
  });

  const imageMsg = makeMessage({
    messageId: 'img-1',
    message: [{ type: 'image', data: { url: 'https://example.com/a.png' } }],
    rawMessage: '[CQ:image,url=https://example.com/a.png]'
  });
  const textMsg = makeMessage({
    messageId: 'txt-1',
    time: 1710000001,
    message: [{ type: 'text', data: { text: '你看这个怎么样' } }],
    rawMessage: '你看这个怎么样'
  });
  const textMsg2 = makeMessage({
    messageId: 'txt-2',
    time: 1710000002,
    message: [{ type: 'text', data: { text: '我刚刚是说包装好怪' } }],
    rawMessage: '我刚刚是说包装好怪'
  });

  const firstPromise = preprocessor.handleMessage(imageMsg, {});
  await new Promise((resolve) => setTimeout(resolve, 110));
  const second = await preprocessor.handleMessage(textMsg, {});
  assert.strictEqual(second.mode, 'deferred', 'follow-up text should join the pending image session');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const third = await preprocessor.handleMessage(textMsg2, {});
  assert.strictEqual(third.mode, 'deferred', 'a second follow-up text should still join the same anchored session');

  const first = await firstPromise;
  assert.strictEqual(first.mode, 'ready');
  assert.deepStrictEqual(first.meta.sourceMessageIds, ['img-1', 'txt-1', 'txt-2']);
  assert.strictEqual(first.meta.selectedImageUrl, 'https://example.com/a.png');
  assert.ok(String(first.effectiveMsg.raw_message || '').includes('你看这个怎么样'));
  assert.ok(String(first.effectiveMsg.raw_message || '').includes('我刚刚是说包装好怪'));
  assert.ok(String(first.effectiveMsg.raw_message || '').includes('[CQ:image,url=https://example.com/a.png]'));
}

async function testPlainTextStillFlushesOnBaseDebounce() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 60,
    atBotDebounceMs: 60,
    privateDebounceMs: 60,
    maxHoldMs: 260
  });

  const firstMsg = makeMessage({
    messageId: 'text-a',
    message: [{ type: 'text', data: { text: '第一句' } }],
    rawMessage: '第一句'
  });
  const secondMsg = makeMessage({
    messageId: 'text-b',
    time: 1710000001,
    message: [{ type: 'text', data: { text: '第二句' } }],
    rawMessage: '第二句'
  });

  const firstPromise = preprocessor.handleMessage(firstMsg, {});
  await new Promise((resolve) => setTimeout(resolve, 90));
  const first = await firstPromise;
  assert.strictEqual(first.mode, 'ready');
  assert.deepStrictEqual(first.meta.sourceMessageIds, ['text-a']);

  const second = await preprocessor.handleMessage(secondMsg, {});
  assert.strictEqual(second.mode, 'ready');
  assert.deepStrictEqual(second.meta.sourceMessageIds, ['text-b']);
}

async function testRegularGroupPlainTextUsesShortDebounceCap() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 300,
    groupPlainTextDebounceMs: 300,
    atBotDebounceMs: 500,
    privateDebounceMs: 450,
    maxHoldMs: 600,
    sentenceWindowMs: 300
  });

  assert.strictEqual(
    preprocessor.getSessionDebounceMs({
      messageType: 'group',
      mentionedBot: false,
      hasLongAggregationAnchor: false
    }),
    300,
    'regular group plain text should not inherit the long aggregation debounce'
  );
  assert.strictEqual(
    preprocessor.getSessionDebounceMs({
      messageType: 'group',
      mentionedBot: false,
      hasLongAggregationAnchor: true
    }),
    300,
    'group messages with image/forward/card anchors should keep the aggregation debounce'
  );
  assert.strictEqual(
    preprocessor.getSessionDebounceMs({
      messageType: 'group',
      mentionedBot: true,
      hasLongAggregationAnchor: false
    }),
    500,
    '@bot group messages should keep the at-bot debounce'
  );
  assert.strictEqual(
    preprocessor.getSessionDebounceMs({
      messageType: 'private',
      mentionedBot: false,
      hasLongAggregationAnchor: false
    }),
    450,
    'private chat should keep the private debounce'
  );

  const msg = makeMessage({
    messageId: 'group-plain-question',
    userId: 'group-user-1',
    groupId: 'group-1',
    messageType: 'group',
    message: [{ type: 'text', data: { text: '这一句已经说完。' } }],
    rawMessage: '这一句已经说完。'
  });

  const startedAt = Date.now();
  const result = await preprocessor.handleMessage(msg, {});
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(result.meta.flushReason, 'debounce');
  assert.ok(elapsed < 450, `plain group text should flush near the short debounce cap, got ${elapsed}ms`);
  assert.ok(result.meta.timing.scheduleDebounceMs <= 300);

  const replyMsg = makeMessage({
    messageId: 'group-reply-short',
    userId: 'group-user-1',
    groupId: 'group-1',
    messageType: 'group',
    message: [
      { type: 'reply', data: { id: 'quoted-1' } },
      { type: 'text', data: { text: ' 对。' } }
    ],
    rawMessage: '[CQ:reply,id=quoted-1]对。'
  });
  const replyStartedAt = Date.now();
  const replyResult = await preprocessor.handleMessage(replyMsg, {});
  const replyElapsed = Date.now() - replyStartedAt;
  assert.strictEqual(replyResult.mode, 'ready');
  assert.ok(replyElapsed < 450, `plain reply text should also use the short cap, got ${replyElapsed}ms`);
}

async function testAtBotSingleImageDoesNotWaitForMaxHold() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 650,
    groupPlainTextDebounceMs: 300,
    atBotDebounceMs: 320,
    privateDebounceMs: 650,
    maxHoldMs: 900,
    ensureCachedImageRef: async () => ({ ok: false })
  });

  const msg = makeMessage({
    messageId: 'at-bot-image',
    userId: 'group-user-2',
    groupId: 'group-2',
    messageType: 'group',
    message: [
      { type: 'at', data: { qq: 'bot_test' } },
      { type: 'image', data: { url: 'https://example.com/at-bot.png' } }
    ],
    rawMessage: '[CQ:at,qq=bot_test][CQ:image,url=https://example.com/at-bot.png]'
  });

  const startedAt = Date.now();
  const result = await preprocessor.handleMessage(msg, { effectiveBotQQ: 'bot_test' });
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(result.meta.flushReason, 'debounce');
  assert.ok(elapsed < 600, `@bot single image should use at-bot debounce instead of max-hold, got ${elapsed}ms`);
  assert.strictEqual(result.meta.timing.scheduleDebounceMs, 320);
  assert.strictEqual(result.meta.timing.scheduleMaxHoldMs, 900);
  assert.strictEqual(result.meta.mentionedBot, true);
  assert.deepStrictEqual(result.meta.sourceMessageIds, ['at-bot-image']);
  assert.strictEqual(result.meta.selectedImageUrl, 'https://example.com/at-bot.png');
}

async function testRegularGroupSingleImageUsesAggregationDebounce() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 320,
    groupPlainTextDebounceMs: 120,
    atBotDebounceMs: 300,
    privateDebounceMs: 300,
    maxHoldMs: 900,
    ensureCachedImageRef: async () => ({ ok: false })
  });

  const msg = makeMessage({
    messageId: 'regular-group-single-image',
    userId: 'group-user-4',
    groupId: 'group-4',
    messageType: 'group',
    message: [
      {
        type: 'image',
        data: {
          summary: '[动画表情]',
          url: 'https://example.com/sticker.gif'
        }
      }
    ],
    rawMessage: '[CQ:image,summary=&#91;动画表情&#93;,url=https://example.com/sticker.gif]'
  });

  const startedAt = Date.now();
  const result = await preprocessor.handleMessage(msg, {});
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(result.meta.flushReason, 'debounce');
  assert.ok(elapsed < 650, `regular group single image should use aggregation debounce instead of max-hold, got ${elapsed}ms`);
  assert.strictEqual(result.meta.timing.scheduleDebounceMs, 320);
  assert.strictEqual(result.meta.timing.scheduleDelayMs, 320);
  assert.strictEqual(result.meta.timing.scheduleMaxHoldMs, 900);
  assert.strictEqual(result.meta.timing.entryCount, 1);
  assert.strictEqual(result.meta.mentionedBot, false);
  assert.deepStrictEqual(result.meta.sourceMessageIds, ['regular-group-single-image']);
  assert.strictEqual(result.meta.selectedImageUrl, 'https://example.com/sticker.gif');
}

async function testImageSummaryCountsAsFollowupText() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 320,
    groupPlainTextDebounceMs: 300,
    atBotDebounceMs: 320,
    privateDebounceMs: 320,
    maxHoldMs: 900,
    ensureCachedImageRef: async () => ({ ok: false })
  });

  const msg = makeMessage({
    messageId: 'image-summary',
    userId: 'group-user-3',
    groupId: 'group-3',
    messageType: 'group',
    message: [
      {
        type: 'image',
        data: {
          summary: '[啊这]',
          url: 'https://example.com/summary.png'
        }
      }
    ],
    rawMessage: '[CQ:image,summary=&#91;啊这&#93;,url=https://example.com/summary.png]'
  });

  const startedAt = Date.now();
  const result = await preprocessor.handleMessage(msg, {});
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(result.meta.flushReason, 'debounce');
  assert.ok(elapsed < 650, `image summary should avoid max-hold follow-up wait, got ${elapsed}ms`);
  assert.strictEqual(result.meta.timing.scheduleDebounceMs, 320);
  assert.strictEqual(result.meta.timing.scheduleMaxHoldMs, 900);
  assert.ok(String(result.effectiveMsg.raw_message || '').includes('啊这'));
  assert.deepStrictEqual(result.meta.sourceMessageIds, ['image-summary']);
}

async function testImageRefsPreferCachedHandles() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 60,
    atBotDebounceMs: 60,
    privateDebounceMs: 60,
    maxHoldMs: 240,
    ensureCachedImageRef: async (url) => ({
      ok: true,
      ref: `cached-image://${String(url || '').split('/').pop().replace(/\W+/g, '-')}`,
      mediaType: 'image/png',
      sourceUrl: url
    })
  });

  const imageMsg = makeMessage({
    messageId: 'img-cache-1',
    message: [{ type: 'image', data: { url: 'https://example.com/current.png' } }],
    rawMessage: '[CQ:image,url=https://example.com/current.png]'
  });
  const textMsg = makeMessage({
    messageId: 'txt-cache-1',
    time: 1710000010,
    message: [{ type: 'text', data: { text: '看这个' } }],
    rawMessage: '看这个'
  });

  const firstPromise = preprocessor.handleMessage(imageMsg, {});
  await new Promise((resolve) => setTimeout(resolve, 90));
  const second = await preprocessor.handleMessage(textMsg, {});
  assert.strictEqual(second.mode, 'deferred');

  const first = await firstPromise;
  assert.strictEqual(first.mode, 'ready');
  assert.strictEqual(first.meta.selectedImageRef, 'cached-image://current-png');
  assert.strictEqual(first.meta.imageRefMap['https://example.com/current.png'], 'cached-image://current-png');
  assert.strictEqual(
    isProjectModuleLoaded('utils/imageVisualSummaryMemory.js'),
    false,
    'disabled visual summary should not load the memory summarizer on the message path'
  );
  assert.strictEqual(
    isProjectModuleLoaded('utils/memory-v3/materializer.js'),
    false,
    'disabled visual summary should not load the memory materializer on the message path'
  );
}

async function testMergedFlushKeepsLatestFreshnessToken() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 50,
    atBotDebounceMs: 50,
    privateDebounceMs: 50,
    maxHoldMs: 180
  });

  const firstMsg = makeMessage({
    messageId: 'fresh-img-1',
    message: [{ type: 'image', data: { url: 'https://example.com/fresh.png' } }],
    rawMessage: '[CQ:image,url=https://example.com/fresh.png]'
  });
  const secondMsg = makeMessage({
    messageId: 'fresh-text-1',
    time: 1710000011,
    message: [{ type: 'text', data: { text: '这是同一轮补充' } }],
    rawMessage: '这是同一轮补充'
  });

  const firstPromise = preprocessor.handleMessage(firstMsg, {
    freshnessSessionKey: 'direct:u1',
    freshnessVersion: 7
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  const second = await preprocessor.handleMessage(secondMsg, {
    freshnessSessionKey: 'direct:u1',
    freshnessVersion: 8
  });
  assert.strictEqual(second.mode, 'deferred');

  const first = await firstPromise;
  assert.strictEqual(first.mode, 'ready');
  assert.strictEqual(first.meta.freshnessSessionKey, 'direct:u1');
  assert.strictEqual(first.meta.flushVersion, 8);
  assert.deepStrictEqual(first.meta.sourceMessageIds, ['fresh-img-1', 'fresh-text-1']);
}

async function testSentenceWindowWaitsForContinuation() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 40,
    atBotDebounceMs: 40,
    privateDebounceMs: 40,
    maxHoldMs: 220,
    sentenceWindowMs: 60,
    sentenceMinChars: 6
  });

  const msg = makeMessage({
    messageId: 'sentence-a',
    message: [{ type: 'text', data: { text: '我还没说完' } }],
    rawMessage: '我还没说完'
  });

  const startedAt = Date.now();
  const result = await preprocessor.handleMessage(msg, {});
  assert.strictEqual(result.mode, 'ready');
  assert.ok(Date.now() - startedAt >= 90, 'incomplete sentence should delay flush for an extra sentence window');
  assert.ok(
    result.meta.semanticDecision === 'continuation_tail' || result.meta.semanticDecision === 'max_hold_fallback',
    'incomplete sentence should either stay in the sentence window or flush on max-hold fallback'
  );
  assert.strictEqual(result.meta.flushVersion, 1);
}

async function testSentenceStableTailFlushesWithoutExtraWait() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 30,
    atBotDebounceMs: 30,
    privateDebounceMs: 30,
    maxHoldMs: 180,
    sentenceWindowMs: 60,
    sentenceMinChars: 6
  });

  const msg = makeMessage({
    messageId: 'sentence-b',
    message: [{ type: 'text', data: { text: '这一句已经说完。' } }],
    rawMessage: '这一句已经说完。'
  });

  const result = await preprocessor.handleMessage(msg, {});
  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(result.meta.semanticDecision, 'complete');
  assert.strictEqual(result.meta.semanticScore, null);
  assert.ok(result.meta.timing.totalMs >= result.meta.timing.waitMs);
  assert.ok(result.meta.timing.scheduleDebounceMs >= 30);
  assert.ok(result.meta.timing.entryCount >= 1);
}

async function testExpiredMaxHoldFlushesWithoutExtraDebounce() {
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 1000,
    atBotDebounceMs: 1000,
    privateDebounceMs: 1000,
    maxHoldMs: 120,
    sentenceWindowMs: 40
  });

  const firstMsg = makeMessage({
    messageId: 'maxhold-a',
    message: [{ type: 'text', data: { text: '第一句还没说完' } }],
    rawMessage: '第一句还没说完'
  });
  const secondMsg = makeMessage({
    messageId: 'maxhold-b',
    time: 1710000021,
    message: [{ type: 'text', data: { text: '第二句补充' } }],
    rawMessage: '第二句补充'
  });

  const firstPromise = preprocessor.handleMessage(firstMsg, {});
  const blockUntil = Date.now() + 350;
  while (Date.now() < blockUntil) {}
  const secondStartedAt = Date.now();
  const second = await preprocessor.handleMessage(secondMsg, {});
  assert.strictEqual(second.mode, 'deferred');

  const first = await firstPromise;
  assert.strictEqual(first.mode, 'ready');
  assert.strictEqual(first.meta.flushReason, 'max_hold');
  assert.deepStrictEqual(first.meta.sourceMessageIds, ['maxhold-a', 'maxhold-b']);
  assert.ok(Date.now() - secondStartedAt < 70, 'expired max-hold should not wait another debounce window');
  assert.ok(first.meta.timing.scheduleDelayMs <= 5, 'expired max-hold should schedule an immediate flush');
  assert.ok(first.meta.timing.sessionAgeMs >= 300);
}

async function testAdminCheckBypassesContinuousHold() {
  assert.strictEqual(
    isCommandBypass({ raw_message: '[CQ:at,qq=bot_test] /check' }, {
      effectiveBotQQ: 'bot_test',
      isAdminUser: true
    }),
    true,
    'admin /check should be recognized before continuous aggregation'
  );
  assert.strictEqual(
    isCommandBypass({ raw_message: '[CQ:at,qq=bot_test] /check' }, {
      effectiveBotQQ: 'bot_test',
      isAdminUser: false
    }),
    false,
    'non-admin /check should not use the admin diagnostic fast path'
  );
  assert.strictEqual(
    isCommandBypass({ raw_message: '[CQ:at,qq=bot_test] /unknown' }, {
      effectiveBotQQ: 'bot_test',
      isAdminUser: true
    }),
    false,
    'unknown admin slash text should not bypass aggregation'
  );

  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 300,
    atBotDebounceMs: 300,
    privateDebounceMs: 300,
    maxHoldMs: 1000,
    ensureCachedImageRef: async () => ({ ok: false })
  });

  const pendingImage = makeMessage({
    messageId: 'admin-fast-img',
    userId: 'admin_1',
    groupId: 'group_1',
    messageType: 'group',
    message: [{ type: 'image', data: { url: 'https://example.com/admin-fast.png' } }],
    rawMessage: '[CQ:image,url=https://example.com/admin-fast.png]'
  });
  const checkMsg = makeMessage({
    messageId: 'admin-fast-check',
    userId: 'admin_1',
    groupId: 'group_1',
    messageType: 'group',
    time: 1710000020,
    message: [
      { type: 'at', data: { qq: 'bot_test' } },
      { type: 'text', data: { text: ' /check' } }
    ],
    rawMessage: '[CQ:at,qq=bot_test] /check'
  });

  const firstPromise = preprocessor.handleMessage(pendingImage, {
    effectiveBotQQ: 'bot_test',
    isAdminUser: true,
    freshnessSessionKey: 'qq-group:group_1:user:admin_1',
    freshnessVersion: 1
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const checkResult = await preprocessor.handleMessage(checkMsg, {
    effectiveBotQQ: 'bot_test',
    isAdminUser: true,
    freshnessSessionKey: 'qq-group:group_1:user:admin_1',
    freshnessVersion: 2
  });

  assert.strictEqual(checkResult.mode, 'ready');
  assert.strictEqual(checkResult.meta.flushReason, 'command_bypass');
  assert.deepStrictEqual(checkResult.meta.sourceMessageIds, ['admin-fast-check']);
  assert.strictEqual(checkResult.effectiveMsg, checkMsg);

  const imageResult = await firstPromise;
  assert.strictEqual(imageResult.mode, 'ready');
  assert.strictEqual(imageResult.meta.flushReason, 'command_bypass');
  assert.deepStrictEqual(imageResult.meta.sourceMessageIds, ['admin-fast-img']);
}

async function testReplyExpansionSkipsOfflineAndRecovers() {
  const calls = [];
  const actionClient = {
    online: false,
    isConnected() {
      return this.online;
    },
    getConnectionState() {
      return {
        connected: this.online,
        readyStateName: this.online ? 'open' : 'closed'
      };
    },
    async callAction(action, params) {
      calls.push({ action, params });
      if (!this.online) throw new Error('should not call NapCat while offline');
      return {
        message_id: String(params.message_id),
        sender: {
          user_id: 'quoted-user',
          nickname: 'Quoted'
        },
        message: [
          { type: 'text', data: { text: '被引用的内容' } }
        ],
        raw_message: '被引用的内容'
      };
    }
  };
  const ensureCachedImageRef = async () => ({ ok: false });
  const msg = makeMessage({
    messageId: 'reply-current',
    rawMessage: '[CQ:reply,id=42]现在这句',
    message: [
      { type: 'reply', data: { id: '42' } },
      { type: 'text', data: { text: '现在这句' } }
    ]
  });

  const offlineEntry = cheapParseMessageEntry(msg);
  await resolveContinuousEntryDetails(offlineEntry, {
    actionClient,
    ensureCachedImageRef,
    resolveReply: true,
    resolveForward: false,
    resolveCards: false
  });
  assert.strictEqual(calls.length, 0, 'offline reply expansion should skip NapCat action');
  assert.strictEqual(offlineEntry.expansionState.reply, 'degraded');
  assert.strictEqual(offlineEntry.replyContext, null);

  actionClient.online = true;
  const recoveredEntry = cheapParseMessageEntry(msg);
  await resolveContinuousEntryDetails(recoveredEntry, {
    actionClient,
    ensureCachedImageRef,
    resolveReply: true,
    resolveForward: false,
    resolveCards: false
  });
  assert.strictEqual(calls.length, 1, 'recovered reply expansion should call NapCat once');
  assert.strictEqual(recoveredEntry.expansionState.reply, 'resolved');
  assert.ok(String(recoveredEntry.replyContext?.text || '').includes('被引用的内容'));
}

(async () => {
  await testImageThenTextMergesIntoOneTurn();
  await testPlainTextStillFlushesOnBaseDebounce();
  await testRegularGroupPlainTextUsesShortDebounceCap();
  await testAtBotSingleImageDoesNotWaitForMaxHold();
  await testRegularGroupSingleImageUsesAggregationDebounce();
  await testImageSummaryCountsAsFollowupText();
  await testImageRefsPreferCachedHandles();
  await testMergedFlushKeepsLatestFreshnessToken();
  await testSentenceWindowWaitsForContinuation();
  await testSentenceStableTailFlushesWithoutExtraWait();
  await testExpiredMaxHoldFlushesWithoutExtraDebounce();
  await testAdminCheckBypassesContinuousHold();
  await testReplyExpansionSkipsOfflineAndRecovers();
  console.log('continuousMessagePreprocessor.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
