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
  politicalContextRequired: false,
  replacementText: '敏感回复已拦截',
  extraWords: [],
  allowWords: []
}, null, 2), 'utf8');
process.env.GROUP_REPLY_SENSITIVE_VENDOR_DIR = sensitiveVendorDir;
process.env.GROUP_REPLY_SENSITIVE_CONFIG_PATH = sensitiveConfigPath;
process.env.ADMIN_USER_IDS = 'admin_sensitive';

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
const {
  getGroupReplySendQueueSize,
  sendGroupReply
} = require('../core/systemGroupReply');
const { registerSensitivePromptContent } = require('../utils/promptSecurity');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertUnawaitedDeltaOrder(createDispatcher, label) {
  const payloads = [];
  const events = [];
  const sentence = (index) => `第${index}段${'内容'.repeat(80)}。`;
  const fullReply = Array.from({ length: 8 }, (_, index) => sentence(index + 1)).join('');
  const dispatcher = createDispatcher({
    runtimeConfig: {
      AI_STREAM_MAX_SEGMENTS: 3,
      AI_STREAM_SEND_GAP_MS: 0
    },
    sendWithRetry: async (payload) => {
      payloads.push(payload);
      await delay(20);
      return true;
    },
    chatType: 'private',
    userId: `${label}_user`,
    senderId: `${label}_user`,
    telemetry: {
      onEvent(event) {
        events.push(event);
      }
    }
  });

  const pendingDeltas = [];
  for (let index = 1; index <= 8; index += 1) {
    const visible = Array.from({ length: index }, (_, sentenceIndex) => sentence(sentenceIndex + 1)).join('');
    pendingDeltas.push(dispatcher.onDelta('', visible));
  }

  await dispatcher.finish(fullReply);
  await Promise.all(pendingDeltas);

  const chunkIndexes = events
    .filter((event) => event.type === 'reply_stream_chunk_start')
    .map((event) => event.chunkIndex);
  assert.strictEqual(payloads.length, 3, `${label} should enforce the configured stream segment limit`);
  assert.strictEqual(dispatcher.getStats().sentSegments, 3, `${label} should count serialized segments once`);
  if (chunkIndexes.length) {
    assert.deepStrictEqual(chunkIndexes, [1, 2, 3], `${label} should serialize unawaited delta callbacks`);
  }
}

async function assertSameGroupStreamOrder(createDispatcher, label) {
  const payloads = [];
  const firstReply = '我感觉先别急着背完整番种表，那个很容易越背越乱。先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。';
  const secondReply = '后来请求的完整回复。';
  const firstDispatcher = createDispatcher({
    runtimeConfig: { AI_STREAM_MAX_SEGMENTS: 2 },
    sendWithRetry: async (payload) => {
      payloads.push(payload.params.message);
      return true;
    },
    chatType: 'group',
    groupId: `${label}_same_group`,
    userId: `${label}_user_a`,
    senderId: `${label}_user_a`
  });
  const secondDispatcher = createDispatcher({
    runtimeConfig: { AI_STREAM_MAX_SEGMENTS: 1 },
    sendWithRetry: async (payload) => {
      payloads.push(payload.params.message);
      return true;
    },
    chatType: 'group',
    groupId: `${label}_same_group`,
    userId: `${label}_user_b`,
    senderId: `${label}_user_b`
  });

  await firstDispatcher.onDelta('', firstReply);
  await Promise.all([
    firstDispatcher.finish(firstReply),
    (async () => {
      await delay(20);
      await secondDispatcher.finish(secondReply);
    })()
  ]);

  assert.deepStrictEqual(payloads, [
    `[CQ:at,qq=${label}_user_a] 我感觉先别急着背完整番种表，那个很容易越背越乱。`,
    '先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。',
    `[CQ:at,qq=${label}_user_b] ${secondReply}`
  ], `${label} should keep each same-group stream contiguous`);
}

async function assertAbortReleasesGroupLease(createDispatcher, label) {
  const payloads = [];
  const groupId = `${label}_abort_group`;
  const firstReply = Array.from({ length: 10 }, () => '我感觉先别急着背完整番种表，那个很容易越背越乱。先把役、振听和立直这三个坑搞懂，再去雀魂低段打一局，遇到无役就看系统提示；这比一上来背全表舒服很多。').join('');
  const dispatcher = createDispatcher({
    runtimeConfig: { AI_STREAM_MAX_SEGMENTS: 2 },
    sendWithRetry: async (payload) => {
      payloads.push(payload.params.message);
      return true;
    },
    chatType: 'group',
    groupId,
    userId: `${label}_user`,
    senderId: `${label}_user`
  });

  await dispatcher.onDelta('', firstReply);
  assert.strictEqual(payloads.length, 1, `${label} should send the first streamed segment before aborting`);
  assert.strictEqual(getGroupReplySendQueueSize(), 1, `${label} should hold the group send lease while streaming`);

  const queuedReply = sendGroupReply({
    sendWithRetry: async (payload) => {
      payloads.push(payload.params.message);
      return true;
    },
    groupId,
    senderId: `${label}_other`,
    replyText: '中止后的普通回复'
  });

  await dispatcher.abort();
  await queuedReply;

  assert.strictEqual(payloads[payloads.length - 1], `[CQ:at,qq=${label}_other] 中止后的普通回复`, `${label} should release the lease for later replies`);
  assert.strictEqual(getGroupReplySendQueueSize(), 0, `${label} group send queue should drain after abort`);
}

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
    '敏感回复已拦截',
    'normal private replies should use the sensitive guard'
  );

  await runtime.sendReply({
    chatType: 'private',
    userId: 'admin_sensitive',
    senderId: 'admin_sensitive',
    replyText: '这句包含 runtime-block'
  });
  assert.strictEqual(
    sentPayloads[sentPayloads.length - 1].params.message,
    '这句包含 runtime-block',
    'admin private replies should bypass the sensitive guard'
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

  const privateSensitiveStreamPayloads = [];
  const privateSensitiveDispatcher = createStreamingDispatcher({
    runtimeConfig: { ADMIN_USER_IDS: ['admin_sensitive'] },
    sendWithRetry: async (payload) => {
      privateSensitiveStreamPayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'private_sensitive_stream',
    senderId: 'private_sensitive_stream'
  });
  await privateSensitiveDispatcher.finish('这一段包含 stream-block');
  assert.strictEqual(privateSensitiveStreamPayloads.length, 1);
  assert.strictEqual(privateSensitiveStreamPayloads[0].params.message, '敏感回复已拦截');

  const adminSensitiveStreamPayloads = [];
  const adminSensitiveDispatcher = createStreamingDispatcher({
    runtimeConfig: { ADMIN_USER_IDS: ['admin_sensitive'] },
    sendWithRetry: async (payload) => {
      adminSensitiveStreamPayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'admin_sensitive',
    senderId: 'admin_sensitive'
  });
  await adminSensitiveDispatcher.finish('这一段包含 stream-block');
  assert.strictEqual(adminSensitiveStreamPayloads.length, 1);
  assert.strictEqual(adminSensitiveStreamPayloads[0].params.message, '这一段包含 stream-block');

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

  const srcPrivateSensitivePayloads = [];
  const srcPrivateSensitiveDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: { ADMIN_USER_IDS: ['admin_sensitive'] },
    sendWithRetry: async (payload) => {
      srcPrivateSensitivePayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'src_private_sensitive',
    senderId: 'src_private_sensitive'
  });
  await srcPrivateSensitiveDispatcher.finish('这一段包含 src-stream-block');
  assert.strictEqual(srcPrivateSensitivePayloads.length, 1);
  assert.strictEqual(srcPrivateSensitivePayloads[0].params.message, '敏感回复已拦截');

  const srcAdminSensitivePayloads = [];
  const srcAdminSensitiveDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: { ADMIN_USER_IDS: ['admin_sensitive'] },
    sendWithRetry: async (payload) => {
      srcAdminSensitivePayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'admin_sensitive',
    senderId: 'admin_sensitive'
  });
  await srcAdminSensitiveDispatcher.finish('这一段包含 src-stream-block');
  assert.strictEqual(srcAdminSensitivePayloads.length, 1);
  assert.strictEqual(srcAdminSensitivePayloads[0].params.message, '这一段包含 src-stream-block');

  const splitPromptFragment = 'P'.repeat(600);
  registerSensitivePromptContent(splitPromptFragment);
  const protectedCorePayloads = [];
  const protectedCoreDispatcher = createStreamingDispatcher({
    runtimeConfig: { AI_STREAM_MAX_SEGMENTS: 1, AI_STREAM_SEND_GAP_MS: 0 },
    sendWithRetry: async (payload) => {
      protectedCorePayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'protected_core_user',
    senderId: 'protected_core_user'
  });
  await protectedCoreDispatcher.onDelta(splitPromptFragment.slice(0, 340), splitPromptFragment.slice(0, 340));
  assert.strictEqual(protectedCorePayloads.length, 0, '敏感指纹未完整前不得提前发送前缀');
  await protectedCoreDispatcher.onDelta(splitPromptFragment.slice(340), splitPromptFragment);
  await protectedCoreDispatcher.finish(splitPromptFragment);
  assert.strictEqual(protectedCorePayloads.length, 1);
  assert.ok(!protectedCorePayloads[0].params.message.includes(splitPromptFragment.slice(0, 64)));

  const protectedSrcPayloads = [];
  const protectedSrcDispatcher = createSrcStreamingDispatcher({
    runtimeConfig: { AI_STREAM_MAX_SEGMENTS: 1, AI_STREAM_SEND_GAP_MS: 0 },
    sendWithRetry: async (payload) => {
      protectedSrcPayloads.push(payload);
      return true;
    },
    chatType: 'private',
    userId: 'protected_src_user',
    senderId: 'protected_src_user'
  });
  await protectedSrcDispatcher.onDelta(splitPromptFragment.slice(0, 340), splitPromptFragment.slice(0, 340));
  assert.strictEqual(protectedSrcPayloads.length, 0);
  await protectedSrcDispatcher.onDelta(splitPromptFragment.slice(340), splitPromptFragment);
  await protectedSrcDispatcher.finish(splitPromptFragment);
  assert.strictEqual(protectedSrcPayloads.length, 1);
  assert.ok(!protectedSrcPayloads[0].params.message.includes(splitPromptFragment.slice(0, 64)));

  await assertUnawaitedDeltaOrder(createStreamingDispatcher, 'core');
  await assertUnawaitedDeltaOrder(createSrcStreamingDispatcher, 'src');
  await assertSameGroupStreamOrder(createStreamingDispatcher, 'core');
  await assertSameGroupStreamOrder(createSrcStreamingDispatcher, 'src');
  await assertAbortReleasesGroupLease(createStreamingDispatcher, 'core');
  await assertAbortReleasesGroupLease(createSrcStreamingDispatcher, 'src');

  fs.rmSync(tempSensitiveDir, { recursive: true, force: true });
  console.log('messageReplyRuntimeFreshness.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
