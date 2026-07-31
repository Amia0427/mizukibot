const assert = require('assert');
const { buildRecallPlan, shouldRunRecallRerank } = require('../utils/memory-v3/queryPolicy');
const { shouldVectorizeMemoryNode } = require('../utils/memory-v3/embeddingPolicy');
const { buildMemoryFilter, buildMemoryVectorRow, rowPassesMemoryFilter } = require('../utils/lancedbMemoryStore/rows');
const { buildRecallEvalGate } = require('../utils/memoryGovernance/recallEvalGate');

const continuity = buildRecallPlan({ userId: 'u1', query: '昨天我们聊了什么', facet: 'journal' });
assert.deepStrictEqual(continuity.allowedSources, ['recent', 'journal', 'task']);
assert.strictEqual(continuity.lexicalFirst, true);
assert.strictEqual(continuity.allowRemoteRerank, false);

const explicitJournal = buildRecallPlan({
  userId: 'u1',
  query: '咖啡订单',
  source: 'journal'
});
assert.strictEqual(explicitJournal.route, 'source/journal');
assert.strictEqual(explicitJournal.facet, 'default');
assert.deepStrictEqual(explicitJournal.allowedSources, ['journal']);
assert.strictEqual(explicitJournal.candidateBudget.rerank, 0);
assert.strictEqual(explicitJournal.lexicalFirst, true);
assert.strictEqual(explicitJournal.allowRemoteRerank, false);
assert.deepStrictEqual(
  shouldRunRecallRerank([{ score: 0.5, lexical: 0.05 }, { score: 0.49, lexical: 0.04 }], explicitJournal),
  { enabled: false, reason: 'plan_disallowed' }
);

const task = buildRecallPlan({ userId: 'u1', query: '继续上次任务', facet: 'task' });
assert.deepStrictEqual(task.allowedSources, ['task', 'recent']);

const group = buildRecallPlan({ userId: 'u1', groupId: 'g1', query: '群里常用说法', facet: 'group' });
assert.deepStrictEqual(group.allowedSources, ['group', 'jargon']);
assert.strictEqual(shouldRunRecallRerank([{ score: 1, lexical: 1 }, { score: 0.2, lexical: 0.5 }], continuity).enabled, false);

assert.strictEqual(shouldVectorizeMemoryNode({ type: 'fact', status: 'active', text: '稳定偏好', confidence: 0.9 }), true);
assert.strictEqual(shouldVectorizeMemoryNode({ type: 'raw_turn', status: 'active', text: '临时闲聊' }), false);
assert.strictEqual(shouldVectorizeMemoryNode({ type: 'fact', status: 'candidate', text: '待确认事实', confidence: 0.9 }), false);
assert.strictEqual(shouldVectorizeMemoryNode({ type: 'fact', status: 'active', text: '低置信事实', confidence: 0.2 }), false);
assert.strictEqual(shouldVectorizeMemoryNode({ type: 'fact', lifecycleStatus: 'superseded', text: '旧事实' }), false);

const row = buildMemoryVectorRow({
  id: 'n1', userId: 'u1', scopeType: 'personal', type: 'fact', status: 'active',
  text: '稳定偏好', confidence: 0.9, updatedAt: 123, versionRoot: 'root-1'
}, { embedding: [1, 0], model: 'test-model', modelVersion: 'bge-m3-v1' });
assert.strictEqual(row.modelVersion, 'bge-m3-v1');
assert.strictEqual(row.versionRoot, 'root-1');
assert.strictEqual(row.sourceTs, 123);
assert.strictEqual(row.confidence, 0.9);
const filter = buildMemoryFilter({ userId: 'u1', allowedSources: ['profile', 'personal'] });
assert.ok(filter.sql.includes("source IN ('personal', 'profile')"));
assert.strictEqual(rowPassesMemoryFilter(row, filter), true);
const gate = buildRecallEvalGate({ judgedCases: 20, recallAt8: 1, mrrAt8: 1, forbiddenHits: 1 });
assert.ok(gate.failures.includes('forbidden_recall_detected'));

console.log('memoryV3RecallPlan.test.js passed');
