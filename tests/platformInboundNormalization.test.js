const assert = require('assert');

const {
  cheapParseMessageEntry,
  createContinuousMessagePreprocessor,
  resolveContinuousEntryDetails
} = require('../core/continuousMessagePreprocessor');
const { createInboundMessage, toLegacyMessage } = require('../src/platforms/contracts');

module.exports = (async () => {
  const inbound = createInboundMessage({
    platform: 'discord',
    eventId: 'message-1',
    occurredAt: 1_710_000_000_123,
    actor: { externalId: 'user-1', displayName: 'Alice' },
    conversation: { chatType: 'group', conversationId: 'channel-1' },
    text: '看看这张图',
    attachments: [{ kind: 'image', url: 'https://cdn.example/current.png' }],
    replyTo: {
      messageId: 'quoted-1',
      senderId: 'user-2',
      senderName: 'Bob',
      text: '被引用的正文',
      imageUrls: ['https://cdn.example/quoted.png']
    },
    mentionsBot: true,
    botExternalId: 'bot-1'
  });
  const msg = toLegacyMessage(inbound);
  let actionCalls = 0;
  const entry = cheapParseMessageEntry(msg, { effectiveBotQQ: 'bot-1' });

  assert.strictEqual(entry.messageId, 'message-1');
  assert.strictEqual(entry.timestamp, 1_710_000_000_123);
  assert.strictEqual(entry.text, '看看这张图');
  assert.deepStrictEqual(entry.imageUrls, ['https://cdn.example/current.png']);
  assert.strictEqual(entry.mentionedBot, true);
  assert.strictEqual(entry.replyMessageId, 'quoted-1');
  assert.strictEqual(entry.replyContext.text, '被引用的正文');
  assert.deepStrictEqual(entry.replyContext.imageUrls, ['https://cdn.example/quoted.png']);

  await resolveContinuousEntryDetails(entry, {
    actionClient: {
      isConnected: () => true,
      async callAction() {
        actionCalls += 1;
        throw new Error('canonical reply must not query OneBot');
      }
    },
    ensureCachedImageRef: async () => ({ ok: false }),
    resolveReply: true,
    resolveForward: false,
    resolveCards: false
  });

  assert.strictEqual(actionCalls, 0);
  assert.strictEqual(entry.expansionState.reply, 'resolved');

  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 300,
    privateDebounceMs: 300,
    maxHoldMs: 300,
    sentenceWindowMs: 300,
    qqCardLinksEnabled: false,
    ensureCachedImageRef: async () => ({ ok: false })
  });
  const processed = await preprocessor.handleMessage(msg, { effectiveBotQQ: 'bot-1' });
  assert.strictEqual(processed.mode, 'ready');
  assert.deepStrictEqual(processed.meta.imageUrls, ['https://cdn.example/current.png']);

  console.log('platformInboundNormalization.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
