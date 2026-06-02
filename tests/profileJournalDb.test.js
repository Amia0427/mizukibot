const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-profile-journal-db-'));
process.env.DATA_DIR = tempRoot;
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');
process.env.MEMORY_PROFILE_GOAL_TTL_DAYS = '1';

const {
  cleanProfileFacts,
  listProfileFacts,
  profileProjectionFromDb,
  resetDbForTests,
  searchProfileFacts,
  upsertProfileFact
} = require('../utils/profileJournalDb');

module.exports = (async () => {
  resetDbForTests();
  const now = Date.now();

  assert.ok(upsertProfileFact({
    id: 'goal-old',
    userId: 'u_db',
    type: 'goal',
    fieldKey: 'goal',
    value: '旧目标：先写 A',
    conflictKey: 'u_db|personal|goal|current',
    status: 'active',
    sourceKind: 'explicit',
    confidence: 0.9,
    createdAt: now - 1000,
    updatedAt: now - 1000
  }).ok);
  assert.ok(upsertProfileFact({
    id: 'goal-new',
    userId: 'u_db',
    type: 'goal',
    fieldKey: 'goal',
    value: '新目标：先写 B',
    conflictKey: 'u_db|personal|goal|current',
    status: 'active',
    sourceKind: 'explicit',
    confidence: 0.99,
    createdAt: now,
    updatedAt: now
  }).ok);
  cleanProfileFacts({ userId: 'u_db', now });

  const activeGoals = listProfileFacts({ userId: 'u_db', status: 'active' }).facts;
  const supersededGoals = listProfileFacts({ userId: 'u_db', status: 'superseded' }).facts;
  assert.ok(activeGoals.some((item) => item.id === 'goal-new'));
  assert.ok(!activeGoals.some((item) => item.id === 'goal-old'));
  assert.ok(supersededGoals.some((item) => item.id === 'goal-old' && item.supersededBy === 'goal-new'));

  upsertProfileFact({
    id: 'stale-like',
    userId: 'u_db',
    type: 'like',
    fieldKey: 'preference_like',
    value: '喜欢过期测试项',
    status: 'active',
    sourceKind: 'extractor',
    confidence: 0.86,
    expiresAt: now - 1,
    createdAt: now - 5000,
    updatedAt: now - 5000
  }, { now });
  cleanProfileFacts({ userId: 'u_db', now });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'stale' }).facts.some((item) => item.id === 'stale-like'));
  assert.ok(!searchProfileFacts('u_db', '过期测试项').results.some((item) => item.id === 'stale-like'));

  upsertProfileFact({
    id: 'coffee-old',
    userId: 'u_db',
    type: 'like',
    fieldKey: 'preference_like',
    value: '喜欢咖啡',
    conflictKey: 'u_db|personal|preference|drink',
    status: 'active',
    sourceKind: 'explicit',
    confidence: 1,
    createdAt: now - 2000,
    updatedAt: now - 2000
  });
  upsertProfileFact({
    id: 'tea-new',
    userId: 'u_db',
    type: 'like',
    fieldKey: 'preference_like',
    value: '喜欢茶',
    conflictKey: 'u_db|personal|preference|drink',
    status: 'active',
    sourceKind: 'explicit',
    confidence: 1,
    createdAt: now + 1,
    updatedAt: now + 1
  }, { originalText: '不是喜欢咖啡，而是喜欢茶', now: now + 1 });

  const superseded = listProfileFacts({ userId: 'u_db', status: 'superseded', limit: 20 }).facts;
  assert.ok(superseded.some((item) => item.id === 'coffee-old' && item.supersededBy === 'tea-new'));

  const projection = profileProjectionFromDb('u_db').profile;
  assert.ok(projection.strictProfile.goals.includes('新目标：先写 B'));
  assert.ok(projection.strictProfile.likes.includes('喜欢茶'));
  assert.ok(!projection.strictProfile.likes.includes('喜欢咖啡'));

  console.log('profileJournalDb.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
