const assert = require('assert');

const {
  createMessageReplyRuntime,
  createStreamingDispatcher
} = require('../core/messageReplyRuntime');

module.exports = (async () => {
  const sentPayloads = [];
  const runtime = createMessageReplyRuntime({
    sendWithRetry: async (payload) => {
      sentPayloads.push(payload);
      return true;
    }
  });

  let allowed = false;
  const unsent = await runtime.sendReply({
    chatType: 'private',
    userId: 'user_a',
    senderId: 'user_a',
    replyText: 'stale reply',
    shouldSend: () => allowed
  });
  assert.strictEqual(unsent, false);
  assert.strictEqual(sentPayloads.length, 0);

  allowed = true;
  const sent = await runtime.sendReply({
    chatType: 'private',
    userId: 'user_a',
    senderId: 'user_a',
    replyText: 'fresh reply',
    shouldSend: () => allowed
  });
  assert.strictEqual(sent, true);
  assert.strictEqual(sentPayloads.length, 1);

  const streamPayloads = [];
  const dispatcher = createStreamingDispatcher({
    runtimeConfig: {},
    sendWithRetry: async (payload) => {
      streamPayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'user_stream',
    senderId: 'user_stream',
    shouldSend: () => false
  });
  await dispatcher.onDelta('abc', '第一段。第二段。');
  await dispatcher.finish('第一段。第二段。');
  assert.strictEqual(streamPayloads.length, 0);

  console.log('messageReplyRuntimeFreshness.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
