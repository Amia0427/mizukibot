const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-rerank-pipeline-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_HYBRID_RECALL_ENABLED = '0';
process.env.MEMORY_RERANK_ENABLED = '0';
process.env.MEMORY_RAG_MIN_SCORE = '0.01';
process.env.MEMORY_RERANK_WEIGHT = '0.9';
process.env.MEMORY_WRITE_PIPELINE_ENABLED = '0';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const { addMemoryItemsBatch, rebuildMemoryIndex, retrieveUnifiedMemoriesAsync } = require('../utils/vectorMemory');
const { mergeRerankScores } = require('../utils/memoryRerankClient');

const conflictKey = 'u_pipe|preference|nickname';
addMemoryItemsBatch([
  {
    userId: 'u_pipe',
    type: 'fact',
    text: '普通昵称讨论和称呼偏好',
    source: 'legacy',
    sourceKind: 'legacy',
    status: 'active',
    confidence: 0.6,
    updatedAt: 1000
  },
  {
    userId: 'u_pipe',
    type: 'like',
    text: '喜欢这个昵称',
    source: 'legacy',
    sourceKind: 'legacy',
    status: 'candidate',
    confidence: 0.82,
    conflictKey,
    updatedAt: 1000
  },
  {
    userId: 'u_pipe',
    type: 'dislike',
    text: '不喜欢这个昵称',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1,
    conflictKey,
    updatedAt: 3000
  }
]);
rebuildMemoryIndex();

module.exports = (async () => {
  const hits = await retrieveUnifiedMemoriesAsync('u_pipe', '昵称 称呼 偏好', 3, {
    rerankCandidates: async (_query, candidates) => mergeRerankScores(candidates, candidates.map((candidate, index) => ({
      index,
      score: candidate.type === 'like' ? 1 : (candidate.type === 'dislike' ? 0.95 : 0.1)
    })), { weight: 0.95 })
  });

  assert.ok(hits.some((hit) => hit.type === 'dislike' && hit.conflictKey === conflictKey), 'expected conflict winner after rerank');
  assert.ok(!hits.some((hit) => hit.type === 'like' && hit.conflictKey === conflictKey), 'expected conflict loser suppressed after rerank');
  assert.ok(hits.some((hit) => hit.rerankScore !== undefined), 'expected rerank metadata');

  console.log('memoryHybridRerankPipeline.test.js passed');
})();
