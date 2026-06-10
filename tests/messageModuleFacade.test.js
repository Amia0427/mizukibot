const assert = require('assert');

const message = require('../src/message');
const messageHandler = require('../core/messageHandler');

assert.strictEqual(typeof message.buildQqRichMessagePayload, 'function');
assert.strictEqual(typeof message.parseBackgroundControlCommand, 'function');
assert.strictEqual(typeof message.createStreamingDispatcher, 'function');
assert.strictEqual(typeof message.isPrivateChatType, 'function');
assert.strictEqual(typeof message.buildQzoneAutodraftPrompt, 'function');
assert.strictEqual(message.routing.detectIntent, require('../core/router').detectIntent);
assert.strictEqual(message.ingress.buildInboundMessageContext, require('../core/messageIngress').buildInboundMessageContext);
assert.strictEqual(message.dispatch.createMessageDispatchCoordinator, require('../core/messageDispatchCoordinator').createMessageDispatchCoordinator);
assert.strictEqual(message.reply.createMessageReplyRuntime, require('../core/messageReplyRuntime').createMessageReplyRuntime);
assert.strictEqual(message.admin.createMessageAdminCoordinator, require('../core/messageAdminCommands').createMessageAdminCoordinator);

assert.strictEqual(
  messageHandler.buildQqRichMessagePayload,
  message.buildQqRichMessagePayload
);
assert.strictEqual(
  messageHandler.parseBackgroundControlCommand,
  message.parseBackgroundControlCommand
);
assert.strictEqual(
  messageHandler.createStreamingDispatcher,
  message.createStreamingDispatcher
);

assert.deepStrictEqual(
  message.parseBackgroundControlCommand('/任务补充 继续查'),
  { type: 'supplement', payload: '继续查' }
);

assert.deepStrictEqual(
  message.buildQqRichMessagePayload('看这个 [[qq_face:14]]', { senderId: '42' }),
  [
    { type: 'at', data: { qq: '42' } },
    { type: 'text', data: { text: ' 看这个 ' } },
    { type: 'face', data: { id: '14' } }
  ]
);

assert.strictEqual(message.isPrivateChatType('private'), true);
assert.strictEqual(message.isPrivateChatType('group'), false);

console.log('messageModuleFacade.test.js passed');
