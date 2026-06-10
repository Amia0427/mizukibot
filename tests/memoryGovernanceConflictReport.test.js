const assert = require('assert');

const { buildConflictClusterReport } = require('../utils/memoryGovernance/conflictReport');

const report = buildConflictClusterReport([{
  id: 'old_like',
  userId: 'u_conflict_report',
  type: 'like',
  text: '喜欢被叫小月',
  status: 'candidate',
  sourceKind: 'extractor',
  confidence: 0.82,
  conflictKey: 'u_conflict_report|nickname|小月',
  updatedAt: 1000
}, {
  id: 'new_dislike',
  userId: 'u_conflict_report',
  type: 'dislike',
  text: '不喜欢被叫小月',
  status: 'active',
  sourceKind: 'explicit',
  confidence: 1,
  conflictKey: 'u_conflict_report|nickname|小月',
  updatedAt: 2000
}, {
  id: 'other',
  userId: 'u_conflict_report',
  type: 'fact',
  text: 'unrelated memory',
  status: 'active',
  confidence: 0.9
}], { userId: 'u_conflict_report' });

assert.strictEqual(report.ok, true);
assert.strictEqual(report.totalClusters, 1);
assert.strictEqual(report.samples[0].winnerId, 'new_dislike');
assert.strictEqual(report.samples[0].recommendation, 'archive_losers_keep_winner');
assert.ok(report.samples[0].members.some((item) => item.id === 'old_like' && item.recommendedAction === 'archive_superseded'));

console.log('memoryGovernanceConflictReport.test.js passed');
