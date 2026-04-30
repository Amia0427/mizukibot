const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-semantic-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_HYBRID_RECALL_ENABLED = '1';
process.env.MEMORY_EMBEDDING_ENABLED = '1';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding';
process.env.MEMORY_RAG_MIN_SCORE = '0.01';
process.env.MEMORY_HYBRID_LEXICAL_WEIGHT = '0.2';
process.env.MEMORY_HYBRID_SEMANTIC_WEIGHT = '1.4';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const { addMemoryItemsBatch, rebuildMemoryIndex, retrieveUnifiedMemoriesAsync } = require('../utils/vectorMemory');
const { attachEmbeddingToItem, isEmbeddingFresh } = require('../utils/memorySemanticIndex');

const semanticItem = attachEmbeddingToItem({
  userId: 'u_semantic',
  type: 'like',
  text: '偏爱拿铁和手冲咖啡',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  confidence: 1,
  updatedAt: 2000,
  scopeType: 'personal',
  entities: [],
  relations: [],
  participants: [],
  meta: {}
}, [1, 0, 0], { model: 'test-embedding', generatedAt: 3000 });

const lexicalDistractor = attachEmbeddingToItem({
  userId: 'u_semantic',
  type: 'topic',
  text: '摄影器材最近在降价',
  source: 'legacy',
  sourceKind: 'legacy',
  status: 'active',
  confidence: 0.7,
  updatedAt: 1000,
  scopeType: 'personal',
  entities: [],
  relations: [],
  participants: [],
  meta: {}
}, [0, 1, 0], { model: 'test-embedding', generatedAt: 3000 });

assert.strictEqual(isEmbeddingFresh(semanticItem), true);
addMemoryItemsBatch([semanticItem, lexicalDistractor]);
rebuildMemoryIndex();

module.exports = (async () => {
  const hits = await retrieveUnifiedMemoriesAsync('u_semantic', '摄影器材', 2, {
    queryEmbedding: [1, 0, 0],
    topRouteType: 'direct_chat',
    routePolicyKey: 'chat/default'
  });

  assert.ok(hits.length >= 2, 'expected both candidates to pass low threshold');
  assert.ok(hits[0].text.includes('咖啡'), 'expected semantic match to outrank lexical distractor');
  assert.ok(hits[0].semantic > hits[1].semantic, 'expected semantic score metadata');

  console.log('memorySemanticRecall.test.js passed');
})();
