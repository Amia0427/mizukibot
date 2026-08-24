const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizukibot-companion-review-'));
process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.DATA_DIR = tempRoot;
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile-journal.sqlite');
process.env.COMPANION_FOLLOWUP_STATE_FILE = path.join(tempRoot, 'followups.json');

module.exports = (async () => {
  const {
    closeDb,
    resetDbForTests,
    upsertJournalEntry
  } = require('../utils/profileJournalDb');

  try {
    resetDbForTests();
    const config = require('../config');
    const { formatDateInTz } = require('../utils/time');
    const today = formatDateInTz(new Date(), config.TIMEZONE);
    assert.ok(upsertJournalEntry({
      id: 'review-current-user',
      userId: 'review-user',
      day: today,
      ts: Date.now() - 1000,
      sessionKey: 'private:review-user',
      turnId: 'review-turn',
      userText: '今天完成了阅读计划',
      assistantText: '记得给自己一点肯定。',
      safety: 'safe',
      status: 'active'
    }).ok);
    assert.ok(upsertJournalEntry({
      id: 'review-other-user',
      userId: 'other-user',
      day: today,
      ts: Date.now(),
      sessionKey: 'private:other-user',
      turnId: 'other-turn',
      userText: '另一位用户的私密内容',
      assistantText: '不应出现在结果里。',
      safety: 'safe',
      status: 'active'
    }).ok);

    const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
    const { enforceToolPolicy, resolveToolPolicy } = require('../utils/toolPolicy');
    const schema = getToolSchemaByName('companion_review');
    const executor = getToolExecutor('companion_review');
    assert.ok(schema);
    assert.strictEqual(typeof executor, 'function');
    assert.deepStrictEqual(enforceToolPolicy('companion_review', { range: 'WEEK' }), { range: 'week' });
    assert.throws(
      () => enforceToolPolicy('companion_review', { range: 'month' }),
      /range 无效/
    );
    const policy = resolveToolPolicy('companion_review', { range: 'today' }).policy;
    assert.strictEqual(policy.effect, 'none');
    assert.strictEqual(policy.confirmation, 'none');

    const privateResult = await executor({
      range: 'today',
      __context: { userId: 'review-user', chatType: 'private' }
    });
    assert.ok(privateResult.includes('今天完成了阅读计划'));
    assert.ok(privateResult.includes('记得给自己一点肯定'));
    assert.ok(!privateResult.includes('另一位用户的私密内容'));
    assert.ok(!privateResult.includes('review-current-user'));

    const groupResult = await executor({
      range: 'today',
      __context: { userId: 'review-user', chatType: 'group' }
    });
    assert.strictEqual(groupResult, '陪伴回顾只支持私聊。');

    console.log('companionReviewIntegration.test.js passed');
  } finally {
    closeDb();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
