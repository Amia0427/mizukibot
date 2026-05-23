const assert = require('assert');

const {
  createEnrichQualityGate
} = require('../utils/postReplyWorker/enrichQualityGate');
const {
  trimTurnsForEnrichBudget
} = require('../utils/postReplyWorker/enrichPhase');

module.exports = (() => {
  const gate = createEnrichQualityGate({
    userId: 'u1',
    groupId: 'g1',
    evidence: [{ turnId: 't1', userText: 'q', assistantText: 'r' }],
    maxWrites: 2
  });

  assert.strictEqual(gate.assess({
    fieldKey: 'group_jargon',
    text: 'group jargon: foo=bar',
    confidence: 0.8,
    requiresGroup: true
  }).allow, true);
  assert.strictEqual(gate.assess({
    fieldKey: 'group_jargon',
    text: 'group jargon: foo=bar',
    confidence: 0.8,
    requiresGroup: true
  }).reason, 'duplicate_text');
  assert.strictEqual(gate.assess({
    fieldKey: 'style_pattern',
    text: 'style: 回复短一点',
    confidence: 0.2,
    requiresUser: true
  }).reason, 'low_confidence');

  const noEvidenceGate = createEnrichQualityGate({ userId: 'u1', groupId: 'g1' });
  assert.strictEqual(noEvidenceGate.assess({
    fieldKey: 'task',
    text: 'chat merge strategy',
    confidence: 0.8,
    requiresUser: true
  }).reason, 'missing_evidence');

  const noGroupGate = createEnrichQualityGate({
    userId: 'u1',
    evidence: [{ turnId: 't1', userText: 'q' }]
  });
  assert.strictEqual(noGroupGate.assess({
    fieldKey: 'group_fact',
    text: '群里共同事实',
    confidence: 0.8,
    requiresGroup: true
  }).reason, 'missing_group_scope');

  const budget = trimTurnsForEnrichBudget([
    { question: 'q1', finalReply: 'r1' },
    { question: 'q2', finalReply: 'r2' },
    { question: 'q3'.repeat(100), finalReply: 'r3'.repeat(100) }
  ], {
    maxTurns: 2,
    maxChars: 50
  });
  assert.strictEqual(budget.truncated, true);
  assert.ok(budget.turns.length <= 2);

  console.log('postReplyEnrichQualityGate.test.js passed');
})();
