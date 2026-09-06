const assert = require('assert');

const {
  createContinuousMessagePreprocessor
} = require('../core/continuousMessagePreprocessor');

function makeMessage({ messageId, userId, rawMessage, message }) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    user_id: userId,
    raw_message: rawMessage,
    message
  };
}

function createPreprocessor(options = {}) {
  return createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 300,
    privateDebounceMs: 300,
    maxHoldMs: 300,
    sentenceWindowMs: 300,
    qqCardLinksEnabled: false,
    ensureCachedImageRef: async () => ({ ok: false }),
    ...options
  });
}

async function testPreparedEntryIsReusedWithoutOneBotLookup() {
  let actionCalls = 0;
  const preprocessor = createPreprocessor({
    actionClient: {
      isConnected: () => true,
      getConnectionState: () => ({ connected: true }),
      async callAction() {
        actionCalls += 1;
        throw new Error('prepared entry must not query OneBot again');
      }
    }
  });
  const msg = makeMessage({
    messageId: 'raw-message-id',
    userId: 'prepared-user',
    rawMessage: '[CQ:reply,id=raw-reply-id]原始消息不应被重新解析',
    message: [
      { type: 'reply', data: { id: 'raw-reply-id' } },
      { type: 'text', data: { text: '原始消息不应被重新解析' } }
    ]
  });
  const preparedEntry = {
    messageId: 'prepared-message-id',
    timestamp: 1_710_000_000_000,
    text: '采用已解析正文。',
    attachmentPrompt: '',
    imageUrls: [],
    imageRefMap: {},
    replyMessageId: 'prepared-reply-id',
    replyContext: {
      messageId: 'prepared-reply-id',
      senderId: 'quoted-user',
      senderName: '引用用户',
      origin: 'reply_quote',
      hasImage: false,
      text: '采用已解析引用',
      imageUrls: [],
      imageRefMap: {}
    },
    forwardIds: ['prepared-forward-id'],
    forwardSummaryText: '采用已解析转发',
    forwardImageUrls: [],
    forwardImageRefMap: {},
    mentionedBot: false,
    qqCardUrls: [],
    cardContexts: [],
    cardOnly: false,
    expansionState: {
      reply: 'resolved',
      forward: 'resolved',
      card: 'skipped'
    }
  };

  const result = await preprocessor.handleMessage(msg, {
    preparedEntry,
    freshnessSessionKey: 'direct:prepared-user',
    freshnessVersion: 9
  });

  assert.strictEqual(result.mode, 'ready');
  assert.strictEqual(actionCalls, 0, 'resolved prepared entry should not repeat OneBot actions');
  assert.deepStrictEqual(result.meta.sourceMessageIds, ['prepared-message-id']);
  assert.strictEqual(result.meta.replyContext.text, '采用已解析引用');
  assert.deepStrictEqual(result.meta.forwardIds, ['prepared-forward-id']);
  assert.strictEqual(result.meta.forwardSummaryText, '采用已解析转发');
  assert.match(result.effectiveMsg.raw_message, /采用已解析正文/);
  assert.doesNotMatch(result.effectiveMsg.raw_message, /原始消息不应被重新解析/);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(preparedEntry, 'freshnessSessionKey'),
    false,
    'internal freshness state must not pollute the caller entry'
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preparedEntry, 'freshnessVersion'), false);
  assert.deepStrictEqual(preparedEntry.expansionState, {
    reply: 'resolved',
    forward: 'resolved',
    card: 'skipped'
  });
}

async function testMissingPreparedEntryKeepsExistingPath() {
  const preprocessor = createPreprocessor();
  const msg = makeMessage({
    messageId: 'fallback-message-id',
    userId: 'fallback-user',
    rawMessage: '未提供 preparedEntry 时仍走原路径。',
    message: [{ type: 'text', data: { text: '未提供 preparedEntry 时仍走原路径。' } }]
  });

  const result = await preprocessor.handleMessage(msg, {});

  assert.strictEqual(result.mode, 'ready');
  assert.deepStrictEqual(result.meta.sourceMessageIds, ['fallback-message-id']);
  assert.match(result.effectiveMsg.raw_message, /未提供 preparedEntry 时仍走原路径/);
}

(async () => {
  await testPreparedEntryIsReusedWithoutOneBotLookup();
  await testMissingPreparedEntryKeepsExistingPath();
  console.log('continuousMessagePreparedEntry.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
