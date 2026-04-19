const assert = require('assert');

const {
  sendGroupReply,
  sendPrivateReply,
  getGroupReplySendQueueSize
} = require('../core/systemGroupReply');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  const sendEvents = [];
  let activeGroupSends = 0;
  let peakSameGroup = 0;
  let peakCrossGroup = 0;
  let activePrivateSends = 0;
  let peakPrivate = 0;

  async function mockedSendWithRetry(payload) {
    const action = String(payload?.action || '').trim();
    const groupId = String(payload?.params?.group_id || '').trim();
    const userId = String(payload?.params?.user_id || '').trim();

    sendEvents.push({
      type: 'start',
      action,
      groupId,
      userId,
      at: Date.now()
    });

    if (action === 'send_group_msg') {
      activeGroupSends += 1;
      if (groupId === 'same_group') {
        peakSameGroup = Math.max(
          peakSameGroup,
          sendEvents.filter((event) => event.type === 'start' && event.groupId === 'same_group').length
            - sendEvents.filter((event) => event.type === 'end' && event.groupId === 'same_group').length
        );
      }
      peakCrossGroup = Math.max(peakCrossGroup, activeGroupSends);
    }

    if (action === 'send_private_msg') {
      activePrivateSends += 1;
      peakPrivate = Math.max(peakPrivate, activePrivateSends);
    }

    await delay(80);

    if (action === 'send_group_msg') {
      activeGroupSends = Math.max(0, activeGroupSends - 1);
    }
    if (action === 'send_private_msg') {
      activePrivateSends = Math.max(0, activePrivateSends - 1);
    }

    sendEvents.push({
      type: 'end',
      action,
      groupId,
      userId,
      at: Date.now()
    });
    return true;
  }

  await Promise.all([
    sendGroupReply({
      sendWithRetry: mockedSendWithRetry,
      groupId: 'same_group',
      senderId: 'user_1',
      replyText: '群内第一条'
    }),
    sendGroupReply({
      sendWithRetry: mockedSendWithRetry,
      groupId: 'same_group',
      senderId: 'user_2',
      replyText: '群内第二条'
    })
  ]);

  assert.strictEqual(peakSameGroup, 1, 'same-group replies should be serialized');
  assert.strictEqual(getGroupReplySendQueueSize(), 0, 'group reply queue should drain after completion');

  await Promise.all([
    sendGroupReply({
      sendWithRetry: mockedSendWithRetry,
      groupId: 'group_a',
      senderId: 'user_1',
      replyText: 'A'
    }),
    sendGroupReply({
      sendWithRetry: mockedSendWithRetry,
      groupId: 'group_b',
      senderId: 'user_2',
      replyText: 'B'
    })
  ]);

  assert.ok(peakCrossGroup >= 2, 'different groups should be allowed to send in parallel');

  await Promise.all([
    sendPrivateReply({
      sendWithRetry: mockedSendWithRetry,
      userId: 'private_1',
      replyText: '私聊一'
    }),
    sendPrivateReply({
      sendWithRetry: mockedSendWithRetry,
      userId: 'private_2',
      replyText: '私聊二'
    })
  ]);

  assert.ok(peakPrivate >= 2, 'private replies should not be forced through the group send queue');

  const payloads = [];
  async function payloadCaptureSendWithRetry(payload) {
    payloads.push(payload);
    return true;
  }

  await sendPrivateReply({
    sendWithRetry: payloadCaptureSendWithRetry,
    userId: 'private_object',
    replyText: {
      visibleText: '对象可见文本',
      persistedText: '对象持久文本'
    }
  });
  assert.strictEqual(
    String(payloads[payloads.length - 1]?.params?.message || ''),
    '对象持久文本',
    'object reply payloads should be normalized to their text fields before sending'
  );

  await sendPrivateReply({
    sendWithRetry: payloadCaptureSendWithRetry,
    userId: 'private_guard',
    replyText: '[object Object]'
  });
  assert.strictEqual(
    String(payloads[payloads.length - 1]?.params?.message || ''),
    '刚才回复出了点格式问题，你再发一次，我马上接住。',
    'stringified object payloads should be blocked before sending to the user'
  );

  console.log('systemGroupReplyQueue.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
