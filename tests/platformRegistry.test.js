const assert = require('assert');

const { createInboundMessage } = require('../src/platforms/contracts');
const { runWithDeliveryContext } = require('../src/platforms/deliveryContext');
const { createPlatformGroupContextStore } = require('../src/platforms/groupContextStore');
const { createPlatformIdentityStore } = require('../src/platforms/identityStore');
const { createPlatformRegistry } = require('../src/platforms/registry');

module.exports = (async () => {
  const identityStore = createPlatformIdentityStore({ databaseFile: ':memory:' });
  const groupContextStore = createPlatformGroupContextStore({ databaseFile: ':memory:' });
  const sent = [];
  const adapter = {
    platform: 'discord',
    capabilities: ['text', 'image', 'reaction'],
    async sendText(target, text, options) {
      sent.push({ type: 'text', target, text, options });
      return true;
    },
    async sendImage(target, image, options) {
      sent.push({ type: 'image', target, image, options });
      return true;
    },
    async react(target, messageId, emoji) {
      sent.push({ type: 'reaction', target, messageId, emoji });
      return true;
    }
  };
  const registry = createPlatformRegistry({ identityStore, groupContextStore });
  registry.register(adapter);

  try {
    const inbound = createInboundMessage({
      platform: 'discord',
      eventId: 'm1',
      actor: { externalId: 'u1', displayName: 'Alice' },
      conversation: { chatType: 'group', containerId: 'g1', conversationId: 'c1' },
      text: 'hello',
      allowPassiveContext: true,
      allowLongTermGroupMemory: false
    });
    const legacy = registry.prepareInbound(inbound);
    assert.strictEqual(legacy.user_id, 'discord:u1');
    assert.strictEqual(groupContextStore.list(inbound.conversation.key).length, 1);

    await runWithDeliveryContext(legacy.delivery_context, async () => {
      const messageResult = await registry.routeLegacyAction({
        action: 'send_group_msg',
        params: {
          group_id: legacy.group_id,
          message: [
            { type: 'text', data: { text: 'reply' } },
            { type: 'image', data: { file: 'image.png' } }
          ]
        }
      });
      assert.deepStrictEqual(messageResult, { handled: true, result: true });

      const reactionResult = await registry.routeLegacyAction({
        action: 'set_msg_emoji_like',
        params: { message_id: 'm1' }
      });
      assert.deepStrictEqual(reactionResult, { handled: true, result: true });
    });

    assert.deepStrictEqual(sent.map((item) => item.type), ['text', 'image', 'reaction']);
    assert.strictEqual(sent[0].options.mentionExternalUserId, 'u1');
    assert.strictEqual(sent[0].options.replyToMessageId, 'm1');

    const qqFallback = await registry.routeLegacyAction({
      action: 'send_group_msg',
      params: { group_id: '123', message: 'qq' }
    });
    assert.deepStrictEqual(qqFallback, { handled: false, result: false });
  } finally {
    groupContextStore.close();
    identityStore.close();
  }

  console.log('platformRegistry.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
