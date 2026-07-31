const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-recall-auto-gold-'));
process.env.DATA_DIR = tempRoot;
process.env.PROMPTS_DIR = path.join(tempRoot, 'prompts');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_ENABLED = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_VECTOR_STORE = 'local_jsonl';
process.env.MEMORY_LANCEDB_READ_ENABLED = 'false';
process.env.DAILY_JOURNAL_ENABLED = 'false';
process.env.PERSONA_WORLDBOOK_EMBEDDING_HOT_PATH = 'false';
process.env.PERSONA_WORLDBOOK_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona'), { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona_modules'), { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona_worldbook'), { recursive: true });

for (const fileName of [
  '01_identity.txt',
  '02_style.txt',
  '03_boundaries.txt',
  '04_behavior.txt',
  '06_state_modulation.txt'
]) {
  fs.writeFileSync(path.join(process.env.PROMPTS_DIR, 'persona', fileName), 'test persona prompt', 'utf8');
}

const { writeJsonLines, atomicWriteText } = require('../utils/memory-v3/helpers');

writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [{
  id: 'node_like_tea',
  userId: 'u_gold',
  scopeType: 'personal',
  sourceKind: 'explicit',
  status: 'active',
  type: 'like',
  memoryKind: 'fact',
  semanticSlot: 'preference_like',
  canonicalKey: 'jasmine tea preference',
  text: 'User likes jasmine tea during late study sessions.',
  confidence: 0.95,
  importance: 0.8,
  evidenceCount: 1,
  evidenceTier: 'strict',
  stabilityScore: 0.9,
  updatedAt: Date.now()
}]);

atomicWriteText(path.join(process.env.PROMPTS_DIR, 'persona_modules', 'module-catalog.json'), JSON.stringify({
  version: 1,
  modules: [{
    id: 'wb_test_jasmine',
    path: 'persona_worldbook/wb_test_jasmine.md',
    purpose: 'Jasmine tea ritual for study nights',
    triggerHints: ['jasmine tea', 'study night'],
    tokenCost: 20,
    priority: 1,
    phase: 'phase2',
    slot: 'daily'
  }]
}, null, 2));
atomicWriteText(
  path.join(process.env.PROMPTS_DIR, 'persona_worldbook', 'wb_test_jasmine.md'),
  'Use a quiet jasmine tea image when the conversation touches study-night rituals.'
);

const {
  assertExplicitCaseSource,
  assertNonEmptyCases,
  buildAutoGoldCases,
  buildCaseQueryOptions,
  countCategoryMismatches,
  countLifecycleLeaks,
  countRecentRecallMisses,
  loadCases,
  parseArgs,
  runMode,
  supplementCasesWithAutoGold
} = require('../scripts/eval-memory-recall');

const cases = buildAutoGoldCases(10);
assert.ok(cases.some((item) => item.expectedIds.includes('node_like_tea')), 'auto gold should include memory node expected id');
assert.ok(cases.some((item) => item.expectedIds.includes('wb_test_jasmine')), 'auto gold should include worldbook expected id');
assert.ok(cases.every((item) => item.expectedIds.length > 0), 'all auto gold cases should be judged');
assert.ok(new Set(cases.map((item) => item.facet)).size >= 2, 'auto gold should not collapse to one facet');
assert.strictEqual(parseArgs(['--mode', 'lancedb', '--limit', '5']).mode, 'lancedb');
const explicitCasesPath = path.join(tempRoot, 'explicit-cases.jsonl');
fs.writeFileSync(explicitCasesPath, `${JSON.stringify({
  id: 'explicit-only',
  userId: 'u_gold',
  query: 'jasmine tea',
  expectedIds: ['node_like_tea']
})}\n`, 'utf8');
assert.strictEqual(parseArgs(['--cases', explicitCasesPath]).casesFile, explicitCasesPath);
assert.deepStrictEqual(loadCases(10, { casesFile: explicitCasesPath }).map((item) => item.id), ['explicit-only']);
const emptyCasesPath = path.join(tempRoot, 'empty-cases.jsonl');
fs.writeFileSync(emptyCasesPath, '', 'utf8');
assert.throws(() => loadCases(10, { casesFile: emptyCasesPath }), /empty/i);
const invalidCasesPath = path.join(tempRoot, 'invalid-cases.jsonl');
fs.writeFileSync(invalidCasesPath, '{invalid json}\n', 'utf8');
assert.throws(() => loadCases(10, { casesFile: invalidCasesPath }), /invalid JSON.*line 1/i);
assert.throws(() => loadCases(10, { casesFile: path.join(tempRoot, 'missing.jsonl') }), /not found/i);
assert.throws(() => assertNonEmptyCases([], 'built cases'), /built cases.*empty/i);
assert.throws(
  () => assertExplicitCaseSource(parseArgs([])),
  /--cases.*--auto-gold.*--build-cases/i
);
assert.doesNotThrow(() => assertExplicitCaseSource(parseArgs(['--cases', explicitCasesPath])));
assert.doesNotThrow(() => assertExplicitCaseSource(parseArgs(['--auto-gold'])));
assert.doesNotThrow(() => assertExplicitCaseSource(parseArgs(['--build-cases'])));
const noInputCli = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'eval-memory-recall.js')], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  env: process.env
});
assert.strictEqual(noInputCli.status, 1);
assert.match(noInputCli.stderr, /--cases.*--auto-gold.*--build-cases/i);
const supplementedCases = supplementCasesWithAutoGold([
  { id: 'manual_1', query: 'manual judged case', expectedIds: ['manual_node'] }
], 3, () => [
  { id: 'gold_1', query: 'gold case one', expectedIds: ['gold_node_1'] },
  { id: 'gold_2', query: 'gold case two', expectedIds: ['gold_node_2'] }
]);
assert.deepStrictEqual(supplementedCases.map((item) => item.id), ['manual_1', 'gold_1', 'gold_2']);
assert.strictEqual(
  buildCaseQueryOptions({ createdAt: 1777268735 }).journalNow.toISOString(),
  '2026-04-27T05:45:35.000Z'
);
assert.strictEqual(countLifecycleLeaks([{ lifecycleStatus: 'superseded' }, { lifecycleStatus: 'active' }]), 1);
assert.strictEqual(countCategoryMismatches([{ category: 'task' }, { category: 'preference' }], { category: 'preference' }), 1);
assert.strictEqual(countRecentRecallMisses([{ source: 'profile' }], { query: '刚才说到哪了', facet: 'continuity' }), 1);
assert.strictEqual(countRecentRecallMisses([{ source: 'recent' }], { query: '刚才说到哪了', facet: 'continuity' }), 0);

module.exports = runMode('local_jsonl', cases, { memoryCli: false }).then((result) => {
  assert.ok(result.judgedCases > 0);
  assert.notStrictEqual(result.recallAt5, null);
  assert.notStrictEqual(result.recallAt8, null);
  assert.notStrictEqual(result.mrrAt5, null);
  assert.notStrictEqual(result.mrrAt8, null);
  assert.ok(result.recallAt5 >= 0.5);
  assert.ok(result.mrrAt5 >= 0.5);
  assert.notStrictEqual(result.promptInjectionRate, null);
  assert.strictEqual(result.wrongHitRate, 0);
  assert.strictEqual(result.leakage, 0);
  assert.strictEqual(result.lifecycleLeakage, 0);
  assert.strictEqual(result.forbiddenHits, 0);
  assert.notStrictEqual(result.answerRelevance, null);
  assert.notStrictEqual(result.faithfulness, null);
  assert.ok(result.bySource.preference || result.bySource.memory || result.byFacet.preference);
  assert.strictEqual(typeof result.lifecycleLeakage, 'number');
  assert.strictEqual(typeof result.categoryMismatches, 'number');
  assert.strictEqual(typeof result.recentRecallMisses, 'number');
  assert.ok(result.latency.stages.totalMs.p50Ms >= 0);
  console.log('memoryRecallAutoGoldEval.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
