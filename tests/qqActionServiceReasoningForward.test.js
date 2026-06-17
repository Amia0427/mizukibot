const assert = require('assert');

const {
  buildReasoningForwardNodes,
  sendReasoningForwardMessage
} = require('../api/qqActionService');

module.exports = (async () => {
  const longReasoning = `a${'中'.repeat(3600)}b`;
  const nodes = buildReasoningForwardNodes(longReasoning, {
    botName: 'TestBot',
    botUin: '10001',
    maxNodeChars: 1000
  });
  assert.ok(nodes.length > 1, 'long reasoning should split into multiple nodes');
  assert.strictEqual(nodes.map((node) => node.data.content).join(''), longReasoning);
  assert.deepStrictEqual(nodes[0], {
    type: 'node',
    data: {
      name: 'TestBot',
      uin: '10001',
      content: longReasoning.slice(0, 1000)
    }
  });

  const calls = [];
  const groupResult = await sendReasoningForwardMessage({
    chatType: 'group',
    groupId: 'g1',
    reasoningText: 'group reasoning'
  }, {
    actionClient: {
      async callAction(action, params) {
        calls.push({ action, params });
      }
    },
    botName: 'Bot',
    botUin: '42'
  });
  assert.strictEqual(groupResult.success, true);
  assert.strictEqual(calls[0].action, 'send_group_forward_msg');
  assert.strictEqual(calls[0].params.group_id, 'g1');
  assert.strictEqual(calls[0].params.messages[0].data.content, 'group reasoning');

  const privateResult = await sendReasoningForwardMessage({
    chatType: 'private',
    userId: 'u1',
    reasoningText: 'private reasoning'
  }, {
    actionClient: {
      async callAction(action, params) {
        calls.push({ action, params });
      }
    }
  });
  assert.strictEqual(privateResult.success, true);
  assert.strictEqual(calls[1].action, 'send_private_forward_msg');
  assert.strictEqual(calls[1].params.user_id, 'u1');

  const failed = await sendReasoningForwardMessage({
    chatType: 'group',
    groupId: 'g1',
    reasoningText: 'will fail'
  }, {
    actionClient: {
      async callAction(action) {
        calls.push({ action });
        throw new Error('forward failed');
      }
    }
  });
  assert.strictEqual(failed.success, false);
  assert.ok(!calls.some((call) => call.action === 'send_group_msg' || call.action === 'send_private_msg'));

  console.log('qqActionServiceReasoningForward.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
