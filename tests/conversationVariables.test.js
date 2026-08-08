const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-conversation-variables-'));
process.env.DATA_DIR = tempRoot;
process.env.CONVERSATION_VARIABLES_ENABLED = 'true';
process.env.CONVERSATION_VARIABLES_PRIMARY_READ = 'true';
process.env.CONVERSATION_VARIABLES_DB_FILE = path.join(tempRoot, 'conversation_variables.sqlite');
process.env.ADMIN_USER_IDS = 'admin-user';

const variables = require('../utils/conversationVariables');

module.exports = (() => {
  variables.resetDbForTests();

  const empty = variables.getSnapshot({ userId: 'new-user', now: 1_000 });
  assert.strictEqual(empty.relationship.stage, 'stranger');
  assert.strictEqual(empty.relationship.boundaryMode, 'guarded');
  assert.strictEqual(empty.character.energy, 60);

  const positive = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:positive-1',
    turnId: 'positive-1',
    source: 'test',
    now: 2_000,
    proposal: {
      relationship: {
        affectionDelta: 6,
        trustDelta: 6,
        familiarityDelta: 8,
        boundarySignal: 'closer',
        attitude: '愿意自然接近'
      },
      character: {
        moodDelta: 20,
        energyDelta: -10,
        stressDelta: -5,
        socialWillingnessDelta: 15
      },
      negativeImpact: 'none',
      reason: '持续友善互动',
      confidence: 0.95
    }
  });
  assert.strictEqual(positive.applied, true);
  assert.strictEqual(positive.snapshot.relationship.stage, 'stranger');
  assert.strictEqual(positive.snapshot.relationship.affection, 3);
  assert.strictEqual(positive.snapshot.character.mood, 12);
  assert.strictEqual(positive.snapshot.character.energy, 52);
  assert.strictEqual(positive.snapshot.character.stress, 15);
  assert.strictEqual(positive.snapshot.character.socialWillingness, 68);

  const duplicate = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:positive-1',
    source: 'test',
    now: 3_000,
    proposal: { relationship: { affectionDelta: 10 }, confidence: 1, reason: '重复任务' }
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(variables.getSnapshot({ userId: 'new-user', now: 3_000 }).relationship.affection, 3);

  const missingEventKey = variables.applyProposal({
    userId: 'new-user',
    source: 'test',
    now: 3_500,
    proposal: { relationship: { affectionDelta: 3 }, confidence: 1, reason: '缺少回合标识' }
  });
  assert.strictEqual(missingEventKey.applied, false);
  assert.strictEqual(missingEventKey.reason, 'missing_event_key');
  assert.strictEqual(missingEventKey.snapshot.relationship.affection, 3);

  const minorNegative = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:minor-negative',
    source: 'test',
    now: 4_000,
    proposal: {
      relationship: { affectionDelta: -4, trustDelta: -4, boundarySignal: 'farther' },
      negativeImpact: 'minor',
      reason: '普通意见分歧',
      confidence: 0.95
    }
  });
  assert.strictEqual(minorNegative.snapshot.relationship.affection, 3);
  assert.strictEqual(minorNegative.snapshot.relationship.trust, 3);

  const unexplainedNegative = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:unexplained-negative',
    source: 'test',
    now: 4_500,
    proposal: {
      relationship: { affectionDelta: -4, trustDelta: -4, boundarySignal: 'farther' },
      negativeImpact: 'deception',
      reason: '',
      confidence: 0.95
    }
  });
  assert.strictEqual(unexplainedNegative.snapshot.relationship.affection, 3);
  assert.strictEqual(unexplainedNegative.snapshot.relationship.trust, 3);

  const majorNegative = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:major-negative',
    source: 'test',
    now: 5_000,
    proposal: {
      relationship: { affectionDelta: -6, trustDelta: -8, boundarySignal: 'farther' },
      negativeImpact: 'boundary_violation',
      reason: '明确越过关系边界',
      confidence: 0.9
    }
  });
  assert.strictEqual(majorNegative.snapshot.relationship.affection, 0);
  assert.strictEqual(majorNegative.snapshot.relationship.trust, 0);
  assert.strictEqual(majorNegative.snapshot.relationship.boundaryMode, 'guarded');

  variables.setOverride({
    scopeType: 'user',
    scopeId: 'new-user',
    key: 'trust',
    value: 90,
    locked: true,
    reason: '人工修正关系',
    actorId: 'admin-user',
    now: 6_000
  });
  const lockedUpdate = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:locked-trust',
    source: 'test',
    now: 7_000,
    proposal: {
      relationship: { trustDelta: -8 },
      negativeImpact: 'deception',
      reason: '锁定测试',
      confidence: 1
    }
  });
  assert.strictEqual(lockedUpdate.snapshot.relationship.trust, 90);
  assert.ok(variables.getEvents({ scopeType: 'user', scopeId: 'new-user', limit: 20 })
    .some((event) => event.status === 'ignored_by_override'));

  variables.clearOverride({
    scopeType: 'user',
    scopeId: 'new-user',
    key: 'trust',
    reason: '恢复自动变化',
    actorId: 'admin-user',
    now: 8_000
  });

  variables.setOverride({
    scopeType: 'user',
    scopeId: 'new-user',
    key: 'affection',
    value: 20,
    locked: false,
    reason: '人工调整当前值但不锁定',
    actorId: 'admin-user',
    now: 8_500
  });
  const unlockedUpdate = variables.applyProposal({
    userId: 'new-user',
    eventKey: 'turn:unlocked-affection',
    source: 'test',
    now: 9_000,
    proposal: {
      relationship: { affectionDelta: 3 },
      reason: '正常正向互动',
      confidence: 1
    }
  });
  assert.strictEqual(unlockedUpdate.snapshot.relationship.affection, 23);

  const decayed = variables.getSnapshot({ userId: 'new-user', now: 2_000 + 10 * 60 * 60 * 1000 });
  assert.strictEqual(decayed.relationship.affection, 23);
  assert.strictEqual(decayed.character.mood, 0);
  assert.strictEqual(decayed.character.energy, 60);
  assert.strictEqual(decayed.character.stress, 20);
  assert.strictEqual(decayed.character.socialWillingness, 60);

  const admin = variables.getSnapshot({ userId: 'admin-user', now: 10_000 });
  assert.strictEqual(admin.relationship.stage, 'intimate_companion');
  assert.strictEqual(admin.relationship.affection, 100);
  assert.ok(admin.overrides.some((item) => item.locked));

  variables.closeDb();
  console.log('conversationVariables.test.js passed');
})();
