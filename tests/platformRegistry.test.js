const assert = require('assert');

const { createConversationKey, createInboundMessage } = require('../src/platforms/contracts');
const { runWithDeliveryContext } = require('../src/platforms/deliveryContext');
const { createPlatformGroupContextStore } = require('../src/platforms/groupContextStore');
const { createPlatformIdentityStore } = require('../src/platforms/identityStore');
const { createPlatformRegistry } = require('../src/platforms/registry');

module.exports = (async () => {
  const identityStore = createPlatformIdentityStore({ databaseFile: ':memory:' });
  const groupContextStore = createPlatformGroupContextStore({ databaseFile: ':memory:' });
  const sent = [];
  const weixinCalls = [];
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
  const registry = createPlatformRegistry({
    identityStore,
    groupContextStore,
    resolvePreferredPrivateTarget(principalId) {
      return principalId === 'preferred-qq'
        ? {
          platform: 'qq',
          chatType: 'private',
          conversationId: principalId,
          externalUserId: principalId
        }
        : null;
    }
  });
  registry.register(adapter);
  registry.register({
    platform: 'weixin',
    async validateTarget(target) {
      weixinCalls.push({ type: 'validate', target });
      return target.chatType === 'private' && target.externalUserId === 'wx-user-1';
    },
    async sendText(target, text) {
      weixinCalls.push({ type: 'text', target, text });
      return true;
    },
    async sendFile(target, file) {
      weixinCalls.push({ type: 'file', target, file });
      return true;
    }
  });

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

    const unknownWeixin = createInboundMessage({
      platform: 'weixin',
      eventId: 'wx-unknown-message',
      actor: { externalId: 'wx-unknown' },
      conversation: { chatType: 'private', conversationId: 'wx-unknown' },
      text: 'must be rejected'
    });
    assert.throws(
      () => registry.prepareInbound(unknownWeixin),
      (error) => error?.code === 'WEIXIN_IDENTITY_NOT_BOUND'
    );
    assert.deepStrictEqual(identityStore.listBindings('weixin:wx-unknown'), []);

    identityStore.bindExternalIdentityToQq({
      platform: 'weixin',
      externalUserId: 'wx-user-1',
      qqUserId: '12345'
    });
    const boundWeixin = createInboundMessage({
      platform: 'weixin',
      eventId: 'wx-message-1',
      actor: { externalId: 'wx-user-1' },
      conversation: { chatType: 'private', conversationId: 'wx-user-1' },
      text: 'hello from weixin'
    });
    const boundWeixinLegacy = registry.prepareInbound(boundWeixin);
    assert.strictEqual(boundWeixinLegacy.user_id, '12345');

    await runWithDeliveryContext(boundWeixinLegacy.delivery_context, async () => {
      const privateResult = await registry.routeLegacyAction({
        action: 'send_private_msg',
        params: { user_id: '12345', message: 'private reply' }
      });
      assert.deepStrictEqual(privateResult, { handled: true, result: true });
    });
    assert.deepStrictEqual(weixinCalls.map((item) => item.type), ['validate', 'text']);

    await runWithDeliveryContext(boundWeixinLegacy.delivery_context, async () => {
      const explicitQqGroup = await registry.routeLegacyAction({
        action: 'send_group_msg',
        params: { group_id: '123', message: 'explicit QQ group operation' }
      });
      assert.deepStrictEqual(explicitQqGroup, { handled: false, result: false });
    });
    assert.deepStrictEqual(weixinCalls.map((item) => item.type), ['validate', 'text']);

    await runWithDeliveryContext(boundWeixinLegacy.delivery_context, async () => {
      const fileResult = await registry.routeLegacyAction({
        action: 'send_private_msg',
        params: { user_id: '12345', message: [{ type: 'file', data: { file: 'D:\\safe\\reply.txt' } }] }
      });
      assert.deepStrictEqual(fileResult, { handled: true, result: true });
    });
    assert.deepStrictEqual(weixinCalls.map((item) => item.type), ['validate', 'text', 'validate', 'file']);

    const forgedWeixinGroupKey = createConversationKey({
      platform: 'weixin',
      chatType: 'group',
      conversationId: 'wx-group-1'
    });
    const groupResult = await registry.routeLegacyAction({
      action: 'send_group_msg',
      params: { group_id: forgedWeixinGroupKey, message: 'must not send' }
    });
    assert.deepStrictEqual(groupResult, { handled: true, result: false });
    assert.deepStrictEqual(weixinCalls.map((item) => item.type), ['validate', 'text', 'validate', 'file']);

    const qqFallback = await registry.routeLegacyAction({
      action: 'send_group_msg',
      params: { group_id: '123', message: 'qq' }
    });
    assert.deepStrictEqual(qqFallback, { handled: false, result: false });

    const preferredQq = await registry.routeLegacyAction({
      action: 'send_private_msg',
      params: { user_id: 'preferred-qq', message: 'proactive' }
    });
    assert.deepStrictEqual(preferredQq, { handled: false, result: false });
  } finally {
    groupContextStore.close();
    identityStore.close();
  }

  console.log('platformRegistry.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
