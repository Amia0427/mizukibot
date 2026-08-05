const assert = require('assert');

const { createInboundMessage } = require('../src/platforms/contracts');
const { runWithDeliveryContext } = require('../src/platforms/deliveryContext');
const { createPlatformActionClient } = require('../src/platforms/runtime');

module.exports = (async () => {
  const qqCalls = [];
  const registry = {
    async routeLegacyAction(payload) {
      return payload.params?.group_id === 'discord-target'
        ? { handled: true, result: 'discord-result' }
        : { handled: false, result: false };
    },
    get() {
      return { getHealth: () => ({ status: 'online' }) };
    }
  };
  const qqActionClient = {
    async callAction(action, params) {
      qqCalls.push({ action, params });
      return 'qq-result';
    },
    getConnectionState() {
      return { connected: false, readyStateName: 'closed' };
    }
  };
  const client = createPlatformActionClient(registry, qqActionClient);

  assert.strictEqual(await client.callAction('send_group_msg', { group_id: 'discord-target' }), 'discord-result');
  assert.strictEqual(await client.callAction('send_group_msg', { group_id: '123' }), 'qq-result');
  assert.strictEqual(qqCalls.length, 1);

  const inbound = createInboundMessage({
    platform: 'discord',
    eventId: 'm1',
    actor: { externalId: 'u1' },
    conversation: { chatType: 'group', conversationId: 'c1' }
  });
  await runWithDeliveryContext({ target: inbound.deliveryTarget }, async () => {
    assert.deepStrictEqual(client.getConnectionState(), { connected: true, readyStateName: 'open' });
  });

  console.log('platformRuntime.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
