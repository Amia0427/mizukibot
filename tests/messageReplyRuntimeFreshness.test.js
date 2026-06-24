const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempSensitiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-runtime-sensitive-'));
const sensitiveVendorDir = path.join(tempSensitiveDir, 'vendor');
const sensitiveConfigPath = path.join(tempSensitiveDir, 'config.json');
fs.mkdirSync(sensitiveVendorDir, { recursive: true });
fs.writeFileSync(path.join(sensitiveVendorDir, 'words.txt'), 'runtime-block\nstream-block\nsrc-stream-block\n', 'utf8');
fs.writeFileSync(sensitiveConfigPath, JSON.stringify({
  enabled: true,
  replacementText: '敏感回复已拦截',
  extraWords: [],
  allowWords: []
}, null, 2), 'utf8');
process.env.GROUP_REPLY_SENSITIVE_VENDOR_DIR = sensitiveVendorDir;
process.env.GROUP_REPLY_SENSITIVE_CONFIG_PATH = sensitiveConfigPath;

const {
  createMessageReplyRuntime,
  createStreamingDispatcher
} = require('../core/messageReplyRuntime');
const {
  createStreamingDispatcher: createSrcStreamingDispatcher
} = require('../src/message/streaming');
const {
  findExplicitSegmentBreakIndex,
  findGroupChatSplitIndex,
  findNaturalSplitIndex,
  getGroupChatStreamSendGapMs
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

  const sensitiveEvents = [];
  const groupSensitiveSent = await runtime.sendReply({
    chatType: 'group',
    groupId: 'group_sensitive',
    senderId: 'user_sensitive',
    replyText: '这句包含 runtime-block',
    telemetry: {
      onEvent(event) {
        sensitiveEvents.push(event);
      }
    }
  });
  assert.strictEqual(groupSensitiveSent, true);
  assert.strictEqual(
    sentPayloads[sentPayloads.length - 1].params.message,
    '[CQ:at,qq=user_sensitive] 敏感回复已拦截'
  );
  assert.ok(sensitiveEvents.some((event) => event.type === 'group_reply_sensitive_blocked'));

  await runtime.sendReply({
    chatType: 'private',
    userId: 'private_sensitive',
    senderId: 'private_sensitive',
    replyText: '这句包含 runtime-block'
  });
  assert.strictEqual(
    sentPayloads[sentPayloads.length - 1].params.message,
    '这句包含 runtime-block',
    'private replies should not use the group sensitive guard'
  );

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
  assert.strictEqual(findGroupChatSplitIndex('这句很短，不应该为了流式硬拆。', { chatType: 'group' }), -1);
  const mediumGroupReply = '我感觉先别急着背完整番种表，那个很容易越背越乱。先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。';
  assert.strictEqual(
    findGroupChatSplitIndex(mediumGroupReply, { chatType: 'group' }),
    '我感觉先别急着背完整番种表，那个很容易越背越乱。'.length
  );
  assert.ok(getGroupChatStreamSendGapMs('补一句短的。', { chatType: 'group', chunkIndex: 1 }) >= 680);

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
  await groupDispatcher.onDelta('', mediumGroupReply);
  await groupDispatcher.finish(mediumGroupReply);
  const groupStreamStats = groupDispatcher.getStats();
  assert.strictEqual(groupStreamPayloads.length, 2);
  assert.strictEqual(groupStreamStats.sentSegments, 2);
  assert.strictEqual(groupStreamStats.hasSentAny, true);
  assert.ok(groupStreamStats.totalSendDurationMs >= 0);
  assert.ok(groupStreamStats.wallMs >= 0);
  assert.strictEqual(groupStreamPayloads[0].action, 'send_group_msg');
  assert.strictEqual(groupStreamPayloads[0].params.message, '[CQ:at,qq=user_stream] 我感觉先别急着背完整番种表，那个很容易越背越乱。');
  assert.strictEqual(groupStreamPayloads[1].params.message, '先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。');
  assert.ok(!groupStreamPayloads[1].params.message.includes('[CQ:at'));

  const cancelledAfterFirstPayloads = [];
  let groupAllowed = true;
  const cancellableGroupReply = '第一段先发出去，别一上来就塞满。第二段本来要补规则细节，但群里有人插话时应该停住，不要继续追发旧上下文。第三段这种收尾也不要再刷屏。';
  const cancellableGroupDispatcher = createStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 3,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      cancelledAfterFirstPayloads.push(payload);
      groupAllowed = false;
      return true;
    },
    chatType: 'group',
    groupId: 'group_cancel',
    userId: 'user_cancel',
    senderId: 'user_cancel',
    shouldSend: () => groupAllowed
  });
  await cancellableGroupDispatcher.onDelta('', cancellableGroupReply);
  await cancellableGroupDispatcher.finish(cancellableGroupReply);
  assert.strictEqual(cancelledAfterFirstPayloads.length, 1);

  const sensitiveStreamPayloads = [];
  const sensitiveStreamEvents = [];
  const sensitiveGroupDispatcher = createStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 1,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      sensitiveStreamPayloads.push(payload);
      return true;
    },
    chatType: 'group',
    groupId: 'group_sensitive_stream',
    userId: 'user_sensitive_stream',
    senderId: 'user_sensitive_stream',
    telemetry: {
      onEvent(event) {
        sensitiveStreamEvents.push(event);
      }
    }
  });
  await sensitiveGroupDispatcher.finish('这一段包含 stream-block');
  assert.strictEqual(sensitiveStreamPayloads.length, 1);
  assert.strictEqual(sensitiveStreamPayloads[0].params.message, '[CQ:at,qq=user_sensitive_stream] 敏感回复已拦截');
  assert.ok(sensitiveStreamEvents.some((event) => event.type === 'group_reply_sensitive_blocked'));

  const srcGroupPayloads = [];
  const srcDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 2,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      srcGroupPayloads.push(payload);
      return true;
    },
    chatType: 'group',
    groupId: 'src_group_stream',
    userId: 'src_user_stream',
    senderId: 'src_user_stream'
  });
  await srcDispatcher.onDelta('', mediumGroupReply);
  await srcDispatcher.finish(mediumGroupReply);
  assert.strictEqual(srcDispatcher.getStats().sentSegments, 2);
  assert.deepStrictEqual(srcGroupPayloads.map((payload) => payload.params.message), [
    '[CQ:at,qq=src_user_stream] 我感觉先别急着背完整番种表，那个很容易越背越乱。',
    '先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。'
  ]);

  const srcCancelledPayloads = [];
  let srcAllowed = true;
  const srcCancellableDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 3,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      srcCancelledPayloads.push(payload);
      srcAllowed = false;
      return true;
    },
    chatType: 'group',
    groupId: 'src_group_cancel',
    userId: 'src_user_cancel',
    senderId: 'src_user_cancel',
    shouldSend: () => srcAllowed
  });
  await srcCancellableDispatcher.onDelta('', cancellableGroupReply);
  await srcCancellableDispatcher.finish(cancellableGroupReply);
  assert.strictEqual(srcCancelledPayloads.length, 1);

  const srcSensitivePayloads = [];
  const srcSensitiveEvents = [];
  const srcSensitiveDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 1,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      srcSensitivePayloads.push(payload);
      return true;
    },
    chatType: 'group',
    groupId: 'src_group_sensitive',
    userId: 'src_user_sensitive',
    senderId: 'src_user_sensitive',
    telemetry: {
      onEvent(event) {
        srcSensitiveEvents.push(event);
      }
    }
  });
  await srcSensitiveDispatcher.finish('这一段包含 src-stream-block');
  assert.strictEqual(srcSensitivePayloads.length, 1);
  assert.strictEqual(srcSensitivePayloads[0].params.message, '[CQ:at,qq=src_user_sensitive] 敏感回复已拦截');
  assert.ok(srcSensitiveEvents.some((event) => event.type === 'group_reply_sensitive_blocked'));

  fs.rmSync(tempSensitiveDir, { recursive: true, force: true });
  console.log('messageReplyRuntimeFreshness.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
