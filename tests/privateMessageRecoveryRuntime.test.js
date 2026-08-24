const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPrivateMessageRecoveryRuntime } = require('../core/privateMessageRecoveryRuntime');
const { createPrivateMessageRecoveryStore } = require('../utils/privateMessageRecoveryStore');

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-message-recovery-runtime-'));
  const filePath = path.join(tempDir, 'state.json');
  const pendingUnanswered = {
    post_type: 'message', message_type: 'private', self_id: 3326471600,
    user_id: 10001, message_id: 101, time: 100, raw_message: 'pending'
  };
  const pendingAnswered = {
    post_type: 'message', message_type: 'private', self_id: 3326471600,
    user_id: 10002, message_id: 102, time: 101, raw_message: 'already answered'
  };
  const pendingCommand = {
    post_type: 'message', message_type: 'private', self_id: 3326471600,
    user_id: 10006, message_id: 106, time: 102, raw_message: '/restart confirm'
  };
  const missed = {
    post_type: 'message', message_type: 'private', self_id: 3326471600,
    user_id: 10003, message_id: 103, time: 110, raw_message: 'missed while offline'
  };

  try {
    const initialStore = createPrivateMessageRecoveryStore({ filePath, now: () => 100000 });
    initialStore.claim(pendingUnanswered);
    initialStore.fail(pendingUnanswered);
    initialStore.claim(pendingAnswered);
    initialStore.fail(pendingAnswered);
    initialStore.claim(pendingCommand);
    initialStore.fail(pendingCommand);

    const store = createPrivateMessageRecoveryStore({ filePath, now: () => 120000 });
    const dispatched = [];
    const actionClient = {
      async callAction(action, params) {
        if (action === 'get_recent_contact') {
          return [
            { chatType: 1, peerUin: '10003', msgTime: '110', lastestMsg: missed },
            {
              chatType: 1,
              peerUin: '10004',
              msgTime: '111',
              lastestMsg: {
                post_type: 'message_sent', message_type: 'private', self_id: 3326471600,
                user_id: 3326471600, message_id: 104, time: 111, raw_message: 'bot reply'
              }
            },
            {
              chatType: 1,
              peerUin: '10005',
              msgTime: '80',
              lastestMsg: {
                post_type: 'message', message_type: 'private', self_id: 3326471600,
                user_id: 10005, message_id: 105, time: 80, raw_message: 'stale'
              }
            }
          ];
        }
        if (action === 'get_friend_msg_history' && String(params.user_id) === '10002') {
          return {
            messages: [
              pendingAnswered,
              {
                post_type: 'message_sent', message_type: 'private', self_id: 3326471600,
                user_id: 3326471600, message_id: 202, time: 102, raw_message: 'normal reply',
                message: [{ type: 'text', data: { text: 'normal reply' } }]
              }
            ]
          };
        }
        if (action === 'get_friend_msg_history' && String(params.user_id) === '10003') {
          return { messages: [missed] };
        }
        if (action === 'get_friend_msg_history') return { messages: [pendingUnanswered] };
        throw new Error(`unexpected action: ${action}`);
      }
    };
    const runtime = createPrivateMessageRecoveryRuntime({
      store,
      actionClient,
      botQq: '3326471600',
      now: () => 120000,
      maxLookbackMs: 60000,
      overlapMs: 0,
      dispatchMessage: async (message) => {
        dispatched.push(message.message_id);
      },
      logger: { log() {}, warn() {}, error() {} }
    });

    const result = await runtime.recover({ fallbackSinceMs: 90000 });
    assert.deepStrictEqual(dispatched, [101, 103]);
    assert.strictEqual(result.replayedPending, 1);
    assert.strictEqual(result.reconciledPending, 2);
    assert.strictEqual(result.replayedMissed, 1);
    assert.strictEqual(result.sinceMs, 90000, 'an explicit zero overlap must be preserved');
    assert.strictEqual(store.getCursorAt(), 120000);
    assert.strictEqual(store.listPending().length, 0);

    console.log('privateMessageRecoveryRuntime.test.js passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
