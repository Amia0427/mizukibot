const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-conversation-variables-migration-'));
process.env.DATA_DIR = tempRoot;
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.CONVERSATION_VARIABLES_ENABLED = 'true';
process.env.CONVERSATION_VARIABLES_DB_FILE = path.join(tempRoot, 'conversation_variables.sqlite');
process.env.ADMIN_USER_IDS = 'admin-user';

fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({
  friend: { points: 180, level: '普通朋友', relationship: '普通朋友', attitude: '友好', trust_score: 30 },
  intimate: { points: 620, level: '亲密伙伴', relationship: '亲密伙伴', attitude: '稳定亲近', trust_score: 80 },
  'admin-user': { points: 999, level: '亲密伙伴', relationship: '亲密伙伴', attitude: '完全信任', trust_score: 100 }
}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, '{}');

const variables = require('../utils/conversationVariables');

module.exports = (() => {
  variables.resetDbForTests();
  const preview = variables.migrateLegacyFavorites({ apply: false });
  assert.strictEqual(preview.apply, false);
  assert.strictEqual(preview.total, 3);
  assert.strictEqual(variables.hasState('friend'), false);

  const applied = variables.migrateLegacyFavorites({ apply: true, backup: true, now: 10_000 });
  assert.strictEqual(applied.migrated, 3);
  assert.ok(applied.backupDir);
  assert.ok(fs.existsSync(path.join(applied.backupDir, 'favorites.json')));
  assert.strictEqual(variables.getSnapshot({ userId: 'friend', now: 11_000 }).relationship.stage, 'friend');
  assert.strictEqual(variables.getSnapshot({ userId: 'intimate', now: 11_000 }).relationship.stage, 'intimate_companion');
  assert.strictEqual(variables.getSnapshot({ userId: 'admin-user', now: 11_000 }).relationship.stage, 'intimate_companion');

  const repeated = variables.migrateLegacyFavorites({ apply: true, backup: false, now: 12_000 });
  assert.strictEqual(repeated.migrated, 0);
  assert.strictEqual(repeated.skipped, 3);

  variables.closeDb();
  console.log('conversationVariablesMigration.test.js passed');
})();
