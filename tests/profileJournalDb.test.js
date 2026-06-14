const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-profile-journal-db-'));
process.env.DATA_DIR = tempRoot;
process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
process.env.PROFILE_JOURNAL_AUTO_CLEAN_INTERVAL_MS = '60000';
process.env.PROFILE_JOURNAL_DB_FILE = path.join(tempRoot, 'profile_journal.sqlite');
process.env.MEMORY_PROFILE_GOAL_TTL_DAYS = '1';

const {
  cleanProfileFacts,
  getDb,
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

  upsertProfileFact({
    id: 'bad-runtime-active',
    userId: 'u_db',
    type: 'like',
    fieldKey: 'preference_like',
    value: '低质量 active 不应召回',
    status: 'active',
    sourceKind: 'extractor',
    confidence: 0.91,
    profileQuality: { ok: false, reasons: ['generic_text'] },
    createdAt: now + 3000,
    updatedAt: now + 3000
  }, { now: now + 3000 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'rejected', force: true, limit: 50 }).facts.some((item) => item.id === 'bad-runtime-active'));
  assert.ok(!searchProfileFacts('u_db', '低质量 active', { force: true }).results.some((item) => item.id === 'bad-runtime-active'));

  upsertProfileFact({
    id: 'bad-explicit-active',
    userId: 'u_db',
    type: 'like',
    fieldKey: 'preference_like',
    value: '显式低质量先候选',
    status: 'active',
    sourceKind: 'explicit',
    confidence: 1,
    profileQuality: { ok: false, reasons: ['too_short'] },
    createdAt: now + 4000,
    updatedAt: now + 4000
  }, { now: now + 4000 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'candidate', force: true, limit: 50 }).facts.some((item) => item.id === 'bad-explicit-active'));
  assert.ok(!profileProjectionFromDb('u_db', { force: true }).profile.strictProfile.likes.includes('显式低质量先候选'));

  for (const [id, value, fieldKey] of [
    ['placeholder-reserved', 'reserved', 'relationship_reply_style'],
    ['placeholder-repeat', 'reserved reserved reserved', 'relationship_salutation'],
    ['placeholder-field', 'relationship_tone', 'relationship_tone']
  ]) {
    upsertProfileFact({
      id,
      userId: 'u_db',
      type: 'relationship',
      fieldKey,
      value,
      status: 'active',
      sourceKind: 'runtime',
      confidence: 0.9,
      profileQuality: { ok: true, reasons: [] },
      createdAt: now + 5000,
      updatedAt: now + 5000
    }, { now: now + 5000 });
  }
  const rejectedPlaceholders = listProfileFacts({ userId: 'u_db', status: 'rejected', force: true, limit: 100 }).facts;
  assert.ok(rejectedPlaceholders.some((item) => item.id === 'placeholder-reserved'));
  assert.ok(rejectedPlaceholders.some((item) => item.id === 'placeholder-repeat'));
  assert.ok(rejectedPlaceholders.some((item) => item.id === 'placeholder-field'));

  upsertProfileFact({
    id: 'structured-state-style',
    userId: 'u_db',
    type: 'style',
    fieldKey: 'style_pattern',
    value: 'style: warmth=high, warmthSource=runtime_inference, playfulness=mid, guardedness=close relationship_reply_style:',
    status: 'active',
    sourceKind: 'runtime',
    confidence: 0.9,
    createdAt: now + 5500,
    updatedAt: now + 5500
  }, { now: now + 5500 });
  upsertProfileFact({
    id: 'structured-state-relationship',
    userId: 'u_db',
    type: 'relationship',
    fieldKey: 'relationship_reply_style',
    value: '用户修正：relationship_distance: close relationship_reply_style: 用户修正：relationship_distance: clos',
    status: 'active',
    sourceKind: 'runtime',
    confidence: 0.9,
    createdAt: now + 5501,
    updatedAt: now + 5501
  }, { now: now + 5501 });
  const rejectedStructuredState = listProfileFacts({ userId: 'u_db', status: 'rejected', force: true, limit: 120 }).facts;
  assert.ok(rejectedStructuredState.some((item) => item.id === 'structured-state-style'));
  assert.ok(rejectedStructuredState.some((item) => item.id === 'structured-state-relationship'));

  getDb().prepare(`
    INSERT INTO profile_facts (
      id, user_id, type, field_key, value, conflict_key, status, confidence, source_kind,
      evidence_count, created_at, updated_at, expires_at, superseded_by, correction_of, quality_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'structured-state-legacy-ok',
    'u_db',
    'relationship',
    'relationship_distance',
    'close relationship_reply_style: 用户修正：relationship_distance: clos',
    'u_db|personal|relationship_distance|legacy-ok',
    'active',
    0.9,
    'runtime',
    2,
    now + 5600,
    now + 5600,
    0,
    '',
    '',
    JSON.stringify({ ok: true, reasons: [] })
  );
  cleanProfileFacts({ userId: 'u_db', now: now + 5601 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'rejected', autoClean: false, limit: 140 }).facts.some((item) => item.id === 'structured-state-legacy-ok'));

  upsertProfileFact({
    id: 'cross-field-label-relationship',
    userId: 'u_db',
    type: 'relationship',
    fieldKey: 'relationship_boundaries',
    value: '关系边界=close relationship_reply_style:',
    status: 'active',
    sourceKind: 'runtime',
    confidence: 0.9,
    createdAt: now + 5700,
    updatedAt: now + 5700
  }, { now: now + 5700 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'rejected', force: true, limit: 160 }).facts.some((item) => item.id === 'cross-field-label-relationship'));

  upsertProfileFact({
    id: 'cross-field-label-persona',
    userId: 'u_db',
    type: 'bot_persona_guardedness',
    fieldKey: 'bot_persona_guardedness',
    value: '边界感=close relationship_reply_style:',
    status: 'active',
    sourceKind: 'runtime',
    confidence: 0.9,
    createdAt: now + 5701,
    updatedAt: now + 5701
  }, { now: now + 5701 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'rejected', force: true, limit: 170 }).facts.some((item) => item.id === 'cross-field-label-persona'));

  profileProjectionFromDb('u_db', { now: now + 6000 });
  getDb().prepare(`
    INSERT INTO profile_facts (
      id, user_id, type, field_key, value, conflict_key, status, confidence, source_kind,
      evidence_count, created_at, updated_at, expires_at, superseded_by, correction_of, quality_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'throttled-bad',
    'u_db',
    'like',
    'preference_like',
    '节流窗口内先不读时清洗',
    'u_db|personal|preference_like|throttled-bad',
    'active',
    0.9,
    'extractor',
    1,
    now + 6500,
    now + 6500,
    0,
    '',
    '',
    JSON.stringify({ ok: false, reasons: ['generic_text'] })
  );
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'active', autoClean: false, limit: 100 }).facts.some((item) => item.id === 'throttled-bad'));
  profileProjectionFromDb('u_db', { now: now + 7000 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'active', autoClean: false, limit: 100 }).facts.some((item) => item.id === 'throttled-bad'));
  cleanProfileFacts({ userId: 'u_db', now: now + 7001 });
  assert.ok(listProfileFacts({ userId: 'u_db', status: 'rejected', autoClean: false, limit: 100 }).facts.some((item) => item.id === 'throttled-bad'));

  console.log('profileJournalDb.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
