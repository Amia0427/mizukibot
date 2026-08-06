const assert = require('assert');

const { createWeixinAdapter } = require('../src/platforms/weixin/adapter');

module.exports = (async () => {
  const calls = [];
  const binding = {
    accountId: 'bot-1',
    ilinkBotId: 'bot-1',
    ilinkUserId: 'wx-user-1',
    qqUserId: '10001',
    status: 'active'
  };
  let inboxItems = [{
    id: 1,
    attempts: 1,
    accountId: 'bot-1',
    peerId: 'wx-user-1',
    qqUserId: '10001',
    payload: {
      messageId: 'wx-message-1',
      canonicalUserId: '10001',
      platformUserId: 'wx-user-1',
      accountId: 'bot-1',
      peerId: 'wx-user-1',
      chatType: 'private',
      text: 'hello',
      attachments: [{ kind: 'file', name: 'note.txt', text: 'content', buffer: Buffer.from('content') }],
      occurredAt: 1_000,
      capabilities: ['text', 'file']
    }
  }];
  const store = {
    getBindingByAccountId(accountId) {
      return accountId === binding.accountId ? binding : null;
    },
    claimInbox() {
      const claimed = inboxItems;
      inboxItems = [];
      return claimed;
    },
    completeInbox(id) {
      calls.push(['completeInbox', id]);
      return true;
    },
    failInbox(id, input) {
      calls.push(['failInbox', id, input]);
      return true;
    },
    enqueueOutbox(input) {
      calls.push(['enqueueOutbox', input]);
      return { inserted: true, item: input };
    },
    appendAudit(input) {
      calls.push(['appendAudit', input]);
    }
  };
  const adapter = createWeixinAdapter({
    enabled: true,
    store,
    createClientId: () => 'client-1',
    now: () => 2_000
  });

  const received = [];
  assert.deepStrictEqual(await adapter.processInboxOnce(async (message) => received.push(message)), {
    claimed: 1,
    completed: 1,
    failed: 0,
    rejected: 0
  });
  assert.strictEqual(received[0].platform, 'weixin');
  assert.strictEqual(received[0].actor.externalId, 'wx-user-1');
  assert.strictEqual(received[0].actor.personId, '10001');
  assert.strictEqual(received[0].conversation.chatType, 'private');
  assert.strictEqual(received[0].deliveryTarget.containerId, 'bot-1');
  assert.strictEqual(received[0].attachments[0].text, 'content');
  assert.deepStrictEqual(calls.shift(), ['completeInbox', 1]);

  const target = {
    platform: 'weixin',
    chatType: 'private',
    containerId: 'bot-1',
    conversationId: 'wx-user-1',
    externalUserId: 'wx-user-1'
  };
  assert.strictEqual(await adapter.validateTarget(target), true);
  assert.strictEqual(await adapter.validateTarget({
    ...target,
    context: { personId: 'other-qq-user' }
  }), false);
  assert.strictEqual(await adapter.sendText(target, 'reply'), true);
  assert.deepStrictEqual(calls.shift(), ['enqueueOutbox', {
    clientId: 'client-1',
    accountId: 'bot-1',
    peerId: 'wx-user-1',
    payload: { text: 'reply', attachments: [] }
  }]);

  assert.strictEqual(await adapter.sendText({ ...target, chatType: 'group' }, 'blocked'), false);
  assert.strictEqual(await adapter.sendText({ ...target, conversationId: 'stranger', externalUserId: 'stranger' }, 'blocked'), false);
  assert.strictEqual(calls.length, 0, 'forged targets must not reach outbox');

  inboxItems = [{
    id: 2,
    attempts: 1,
    accountId: 'bot-1',
    peerId: 'stranger',
    qqUserId: '10001',
    payload: {
      messageId: 'forged',
      canonicalUserId: '10001',
      platformUserId: 'stranger',
      accountId: 'bot-1',
      peerId: 'stranger',
      chatType: 'private'
    }
  }];
  assert.deepStrictEqual(await adapter.processInboxOnce(async () => {
    throw new Error('forged inbox must not dispatch');
  }), {
    claimed: 1,
    completed: 1,
    failed: 0,
    rejected: 1
  });
  assert.strictEqual(calls[0][0], 'appendAudit');
  assert.strictEqual(calls[0][1].reason, 'inbox_binding_mismatch');
  assert.deepStrictEqual(calls[1], ['completeInbox', 2]);

  console.log('weixinAdapter.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
