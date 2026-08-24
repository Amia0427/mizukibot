const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPrivateMessageRecoveryStore } = require('../utils/privateMessageRecoveryStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-message-recovery-store-'));
const filePath = path.join(tempDir, 'state.json');
const message = {
  post_type: 'message',
  message_type: 'private',
  self_id: 3326471600,
  user_id: 3884719352,
  message_id: 2134045230,
  time: 1787552569,
  raw_message: 'test message'
};

try {
  const store = createPrivateMessageRecoveryStore({ filePath, now: () => 1000 });
  assert.strictEqual(store.claim(message).accepted, true);
  assert.strictEqual(store.claim(message).accepted, false, 'active duplicate should be skipped');

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(Object.keys(persisted.pending).length, 1, 'claim must flush before reply processing');

  store.fail(message);
  const restarted = createPrivateMessageRecoveryStore({ filePath, now: () => 2000 });
  assert.strictEqual(restarted.listPending().length, 1);
  assert.strictEqual(restarted.claim(message).accepted, true, 'pending message should be claimable after restart');

  restarted.complete(message);
  const completed = createPrivateMessageRecoveryStore({ filePath, now: () => 3000 });
  assert.strictEqual(completed.listPending().length, 0);
  assert.strictEqual(completed.claim(message).accepted, false, 'completed message must not be replayed');

  const groupMessage = { ...message, message_type: 'group', group_id: 1 };
  assert.strictEqual(completed.claim(groupMessage).tracked, false);

  const command = { ...message, message_id: 999, raw_message: '/restart confirm' };
  assert.strictEqual(completed.claim(command).tracked, true, 'commands are persisted before acknowledgement');

  const failedFilePath = path.join(tempDir, 'write-failure.json');
  const failedStore = createPrivateMessageRecoveryStore({ filePath: failedFilePath });
  const failedMessage = { ...message, message_id: 1000 };
  const renameSync = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('simulated rename failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.throws(() => failedStore.claim(failedMessage), /simulated rename failure/);
    assert.throws(
      () => failedStore.claim(failedMessage),
      /simulated rename failure/,
      'a failed persistence attempt must remain retryable'
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(failedStore.claim(failedMessage).accepted, true);
  failedStore.complete(failedMessage);

  completed.checkpoint(4000);
  assert.strictEqual(completed.getCursorAt(), 4000);
  console.log('privateMessageRecoveryStore.test.js passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
