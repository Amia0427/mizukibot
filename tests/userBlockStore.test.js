const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { blockUser, closeDb, getActiveBlock, unblockUser } = require('../utils/userBlockStore');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-user-block-store-'));
const dbFile = path.join(dataDir, 'user_blocks.sqlite');

try {
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 1_000 }), null);

  const timed = blockUser({
    userId: '10001',
    durationMs: 60_000,
    blockedBy: 'admin',
    now: 1_000,
    dbFile
  });
  assert.strictEqual(timed.userId, '10001');
  assert.strictEqual(timed.expiresAt, 61_000);
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 60_999 }).expiresAt, 61_000);
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 61_000 }), null);

  const permanent = blockUser({
    userId: '10001',
    durationMs: 0,
    blockedBy: 'admin',
    now: 2_000,
    dbFile
  });
  assert.strictEqual(permanent.expiresAt, 0);
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: Number.MAX_SAFE_INTEGER }).expiresAt, 0);

  assert.deepStrictEqual(unblockUser({ userId: '10001', dbFile }), { removed: true, userId: '10001' });
  assert.deepStrictEqual(unblockUser({ userId: '10001', dbFile }), { removed: false, userId: '10001' });
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 2_000 }), null);

  console.log('userBlockStore.test.js passed');
} finally {
  closeDb();
}
