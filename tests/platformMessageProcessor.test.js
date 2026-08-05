const assert = require('assert');

const { createInboundMessage, toLegacyMessage } = require('../src/platforms/contracts');
const { getDeliveryContext } = require('../src/platforms/deliveryContext');
const { createPlatformMessageProcessor } = require('../src/platforms/messageProcessor');

module.exports = (async () => {
  const sends = [];
  const processor = createPlatformMessageProcessor({
    identityCommandHandler: {
      handle(input) {
        return input.text === '/bindings'
          ? { handled: true, replyText: 'bindings' }
          : { handled: false };
      }
    },
    commandHandlers: [],
    async sendWithRetry(payload) {
      sends.push({ payload, context: getDeliveryContext() });
      return true;
    }
  });
  const canonical = createInboundMessage({
    platform: 'telegram',
    eventId: '1',
    actor: { externalId: '9' },
    conversation: { chatType: 'private', conversationId: '9' },
    text: '/bindings'
  });
  const legacy = toLegacyMessage(canonical);
  legacy.canonical_message = canonical;
  legacy.delivery_context = { target: canonical.deliveryTarget, messageId: canonical.eventId };

  let mainHandlerCalled = false;
  await processor.run(legacy, async () => {
    mainHandlerCalled = true;
  });
  assert.strictEqual(mainHandlerCalled, false);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].payload.action, 'send_private_msg');
  assert.strictEqual(sends[0].context.target.platform, 'telegram');

  canonical.text = 'hello';
  await processor.run(legacy, async () => {
    mainHandlerCalled = true;
    assert.strictEqual(getDeliveryContext().target.platform, 'telegram');
  });
  assert.strictEqual(mainHandlerCalled, true);

  canonical.platform = 'discord';
  canonical.text = '/qzone_post hello';
  mainHandlerCalled = false;
  await processor.run(legacy, async () => {
    mainHandlerCalled = true;
  });
  assert.strictEqual(mainHandlerCalled, false);
  assert.strictEqual(sends[1].payload.params.message, '这个命令仅支持 QQ 平台。');

  console.log('platformMessageProcessor.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
