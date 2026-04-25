const assert = require('assert');

const {
  createMessageReplyRuntime,
  createStreamingDispatcher
} = require('../core/messageReplyRuntime');
const {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex
} = require('../core/streamingSegmentation');

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

  assert.strictEqual(findNaturalSplitIndex('第一句。第二句。'), '第一句。'.length);
  assert.strictEqual(findNaturalSplitIndex('可以吗？可以！'), '可以吗？'.length);
  assert.strictEqual(findExplicitSegmentBreakIndex('第一段\n\n第二段'), '第一段\n\n'.length);
  assert.strictEqual(findNaturalSplitIndex('- 这是一个还没结束的列表项。后面继续'), -1);
  assert.strictEqual(findNaturalSplitIndex('```js\nconsole.log("第一句。第二句。")'), -1);

  const groupStreamPayloads = [];
  const groupDispatcher = createStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 2,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      groupStreamPayloads.push(payload);
      return true;
    },
    chatType: 'group',
    groupId: 'group_stream',
    userId: 'user_stream',
    senderId: 'user_stream'
  });
  await groupDispatcher.onDelta('', '第一段。第二段。第三段。');
  await groupDispatcher.finish('第一段。第二段。第三段。');
  assert.strictEqual(groupStreamPayloads.length, 2);
  assert.strictEqual(groupStreamPayloads[0].action, 'send_group_msg');
  assert.strictEqual(groupStreamPayloads[0].params.message, '[CQ:at,qq=user_stream] 第一段。');
  assert.strictEqual(groupStreamPayloads[1].params.message, '第二段。第三段。');
  assert.ok(!groupStreamPayloads[1].params.message.includes('[CQ:at'));

  console.log('messageReplyRuntimeFreshness.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
