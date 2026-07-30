const assert = require('assert');

const {
  sendGroupImageMessage,
  sendImageMessageForContext,
  sendPrivateImageMessage
} = require('../api/qqActionService');

module.exports = (async () => {
  const actionCalls = [];
  const actionClient = {
    async callAction(action, params) {
      actionCalls.push({ action, params });
      return { message_id: `message-${actionCalls.length}` };
    }
  };

  const groupResult = await sendGroupImageMessage('g1', Buffer.from('group-image'), { actionClient });
  assert.strictEqual(groupResult.success, true);
  assert.strictEqual(groupResult.messageId, 'message-1');
  assert.strictEqual(actionCalls[0].action, 'send_group_msg');
  assert.strictEqual(actionCalls[0].params.group_id, 'g1');
  assert.strictEqual(actionCalls[0].params.message[0].type, 'image');
  assert.ok(actionCalls[0].params.message[0].data.file.startsWith('base64://'));

  const privateResult = await sendPrivateImageMessage('u1', Buffer.from('private-image'), { actionClient });
  assert.strictEqual(privateResult.success, true);
  assert.strictEqual(privateResult.messageId, 'message-2');
  assert.strictEqual(actionCalls[1].action, 'send_private_msg');
  assert.strictEqual(actionCalls[1].params.user_id, 'u1');

  const groupContextResult = await sendImageMessageForContext({
    chatType: 'group',
    groupId: 'g2',
    userId: 'u2'
  }, Buffer.from('context-group-image'), { actionClient });
  assert.strictEqual(groupContextResult.messageId, 'message-3');
  assert.strictEqual(actionCalls[2].action, 'send_group_msg');
  assert.strictEqual(actionCalls[2].params.group_id, 'g2');

  const privateContextResult = await sendImageMessageForContext({
    chatType: 'private',
    userId: 'u3'
  }, Buffer.from('context-private-image'), { actionClient });
  assert.strictEqual(privateContextResult.messageId, 'message-4');
  assert.strictEqual(actionCalls[3].action, 'send_private_msg');
  assert.strictEqual(actionCalls[3].params.user_id, 'u3');

  console.log('visualRenderQqActionService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
