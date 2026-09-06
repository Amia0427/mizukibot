const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { blockUser, closeDb, getActiveBlock, unblockUser } = require('../utils/userBlockStore');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-user-block-store-'));
const dbFile = path.join(dataDir, 'user_blocks.sqlite');
const legacyDbFile = path.join(dataDir, 'legacy-user-blocks.sqlite');

try {
  const legacyDb = new Database(legacyDbFile);
  legacyDb.exec(`
    CREATE TABLE user_blocks (
      user_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL DEFAULT 0,
      blocked_by TEXT NOT NULL,
      blocked_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO user_blocks(user_id, expires_at, blocked_by, blocked_at, updated_at)
    VALUES ('legacy-user', 0, 'admin', 500, 500);
  `);
  legacyDb.close();

  const migrated = getActiveBlock('legacy-user', { dbFile: legacyDbFile, now: 1_000 });
  assert.strictEqual(migrated.blockSource, 'manual');
  assert.strictEqual(migrated.reasonCode, '');

  closeDb();
  const migratedDb = new Database(legacyDbFile, { readonly: true });
  const migratedRecord = migratedDb.prepare(`
    SELECT block_source, reason_code
    FROM user_blocks
    WHERE user_id = ?
  `).get('legacy-user');
  const migratedColumns = new Map(
    migratedDb.pragma('table_info(user_blocks)').map((column) => [column.name, column])
  );
  migratedDb.close();
  assert.strictEqual(migratedRecord.block_source, 'manual');
  assert.strictEqual(migratedRecord.reason_code, '');
  assert.strictEqual(migratedColumns.get('block_source').notnull, 1);
  assert.strictEqual(migratedColumns.get('block_source').dflt_value, "'manual'");
  assert.strictEqual(migratedColumns.get('reason_code').notnull, 1);
  assert.strictEqual(migratedColumns.get('reason_code').dflt_value, "''");

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
  assert.strictEqual(timed.blockSource, 'manual');
  assert.strictEqual(timed.reasonCode, '');
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 60_999 }).expiresAt, 61_000);
  assert.strictEqual(getActiveBlock('10001', { dbFile, now: 61_000 }), null);

  blockUser({
    userId: 'automatic-user',
    durationMs: 60_000,
    blockedBy: 'admin',
    now: 1_000,
    dbFile
  });
  const automatic = blockUser({
    userId: 'automatic-user',
    durationMs: 15 * 60_000,
    blockedBy: 'system',
    blockSource: 'automatic_safety',
    reasonCode: 'political',
    now: 1_500,
    dbFile
  });
  assert.strictEqual(automatic.blockSource, 'automatic_safety');
  assert.strictEqual(automatic.reasonCode, 'political');
  assert.strictEqual(getActiveBlock('automatic-user', { dbFile, now: 2_000 }).blockSource, 'automatic_safety');

  const manuallyReblocked = blockUser({
    userId: 'automatic-user',
    durationMs: 60_000,
    blockedBy: 'admin',
    now: 2_000,
    dbFile
  });
  assert.strictEqual(manuallyReblocked.blockSource, 'manual');
  assert.strictEqual(manuallyReblocked.reasonCode, '');

  const persistedManualBlock = getActiveBlock('automatic-user', { dbFile, now: 2_001 });
  assert.strictEqual(persistedManualBlock.blockSource, 'manual');
  assert.strictEqual(persistedManualBlock.reasonCode, '');
  assert.deepStrictEqual(unblockUser({ userId: 'automatic-user', dbFile }), {
    removed: true,
    userId: 'automatic-user'
  });
  assert.strictEqual(getActiveBlock('automatic-user', { dbFile, now: 2_000 }), null);

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
