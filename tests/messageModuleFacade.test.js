const assert = require('assert');

const message = require('../src/message');
const messageHandler = require('../core/messageHandler');

function assertFunctions(target, names) {
  for (const name of names) {
    assert.strictEqual(typeof target[name], 'function', `${name} must be exported`);
  }
}

assertFunctions(message, [
  'buildQqRichMessagePayload',
  'parseBackgroundControlCommand',
  'createStreamingDispatcher',
  'isPrivateChatType',
  'buildQzoneAutodraftPrompt'
]);
assertFunctions(message.routing, ['detectIntent']);
assertFunctions(message.ingress, ['buildInboundMessageContext']);
assertFunctions(message.dispatch, ['createMessageDispatchCoordinator']);
assertFunctions(message.reply, ['createMessageReplyRuntime']);
assertFunctions(message.admin, ['createMessageAdminCoordinator']);
assertFunctions(messageHandler, [
  'buildQqRichMessagePayload',
  'parseBackgroundControlCommand',
  'createStreamingDispatcher'
]);

const imageSummaryRoute = message.routing.detectIntent({
  rawText: '请总结这张图片 [CQ:image,url=https://example.com/a.jpg]',
  botQQ: '42',
  userId: 'u1',
  chatType: 'group'
});
assert.strictEqual(imageSummaryRoute.topRouteType, 'direct_chat');
assert.strictEqual(imageSummaryRoute.meta.chatMode, 'image_summary');
assert.strictEqual(imageSummaryRoute.facets.sourceScope, 'vision');

const inboundContext = message.ingress.buildInboundMessageContext({
  msg: {
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u1',
    message_id: 'm1',
    sender: { nickname: '甲' }
  },
  rawText: '原文',
  cleanText: '正文',
  isAtBot: true,
  botQQ: '42'
});
assert.strictEqual(inboundContext.groupId, 'g1');
assert.strictEqual(inboundContext.senderId, 'u1');
assert.strictEqual(inboundContext.chatType, 'group');
assert.strictEqual(inboundContext.messageMeta.messageId, 'm1');
assert.strictEqual(inboundContext.isAtBot, true);

const supplementCommand = { type: 'supplement', payload: '继续查' };
assert.deepStrictEqual(message.parseBackgroundControlCommand('/任务补充 继续查'), supplementCommand);
assert.deepStrictEqual(messageHandler.parseBackgroundControlCommand('/任务补充 继续查'), supplementCommand);

const richPayload = [
  { type: 'at', data: { qq: '42' } },
  { type: 'text', data: { text: ' 看这个 ' } },
  { type: 'face', data: { id: '14' } }
];
assert.deepStrictEqual(
  message.buildQqRichMessagePayload('看这个 [[qq_face:14]]', { senderId: '42' }),
  richPayload
);
assert.deepStrictEqual(
  messageHandler.buildQqRichMessagePayload('看这个 [[qq_face:14]]', { senderId: '42' }),
  richPayload
);

assert.strictEqual(message.isPrivateChatType('private'), true);
assert.strictEqual(message.isPrivateChatType('group'), false);

console.log('messageModuleFacade.test.js passed');
