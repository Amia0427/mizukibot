const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-bm25-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_EMBEDDING_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_BM25_ENABLED = 'true';
process.env.MEMORY_RRF_ENABLED = 'true';
process.env.MEMORY_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const {
  buildBm25Index,
  calcBm25Score,
  normalizeBm25Score
} = require('../utils/memory-v3/queryScoring');
const { queryMemory } = require('../utils/memory-v3/query');

const exact = {
  id: 'node_bm25_exact',
  userId: 'u_bm25',
  scopeType: 'personal',
  sourceKind: 'explicit',
  status: 'active',
  type: 'fact',
  memoryKind: 'fact',
  fieldKey: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'blue tin',
  text: 'The spare keyboard cable is stored in the blue tin beside the monitor.',
  confidence: 0.9,
  importance: 0.8,
  evidenceCount: 1,
  evidenceTier: 'strict',
  stabilityScore: 0.9,
  updatedAt: Date.now()
};
const distractor = {
  ...exact,
  id: 'node_bm25_distractor',
  canonicalKey: 'tea cup',
  text: 'The jasmine tea cup is on the kitchen shelf.',
  stabilityScore: 0.4
};

writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [exact, distractor]);

const index = buildBm25Index([exact, distractor], 'default');
const exactScore = calcBm25Score(['blue', 'tin', 'cable'], exact, index);
const distractorScore = calcBm25Score(['blue', 'tin', 'cable'], distractor, index);
assert.ok(exactScore > distractorScore, 'BM25 should prefer exact lexical memory');
assert.ok(normalizeBm25Score(exactScore) > 0 && normalizeBm25Score(exactScore) < 1);

module.exports = queryMemory({
  userId: 'u_bm25',
  query: 'where is blue tin cable',
  facet: 'default',
  topK: 4
}).then((result) => {
  assert.strictEqual(result.results[0].id, 'node_bm25_exact');
  assert.strictEqual(result.stats.retrievalPlan.bm25Enabled, true);
  assert.strictEqual(result.stats.retrievalPlan.rrfEnabled, true);
  assert.ok(result.diagnostics.recall.rankFusion.bm25.some((item) => item.id === 'node_bm25_exact'));
  assert.ok(result.diagnostics.recall.rerank.beforeTop.length > 0);
  console.log('memoryV3Bm25RrfDiagnostics.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
