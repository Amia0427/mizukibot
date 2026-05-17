const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-vector-prompt-guarantee-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_RAG_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_VECTOR_STORE = 'local_jsonl';
process.env.MEMORY_STRONG_SEMANTIC_MIN_SCORE = '0.8';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.5';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.1';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildEmbeddingIdentity } = require('../utils/memory-v3/embeddingIndex');
const { queryMemory } = require('../utils/memory-v3/query');
const { buildMemoryContextAsync } = require('../utils/memoryContext');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { addMemoryItemsBatch } = require('../utils/vectorMemory');

const now = Date.now();
const strongNode = {
  id: 'node_prompt_strong',
  userId: 'u_prompt_vector',
  scopeType: 'personal',
  source: 'extractor',
  sourceKind: 'extractor',
  status: 'candidate',
  type: 'fact',
  memoryKind: 'fact',
  fieldKey: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'obsidian charging cable',
  text: 'the backup charging cable is hidden in the obsidian case',
  confidence: 0.9,
  importance: 0.9,
  evidenceCount: 1,
  evidenceTier: 'weak',
  stabilityScore: 0.8,
  updatedAt: now
};
const weakNode = {
  ...strongNode,
  id: 'node_prompt_weak',
  canonicalKey: 'weak irrelevant snack',
  text: 'maybe mentioned a temporary snack once',
  confidence: 0.4,
  importance: 0.2,
  evidenceTier: 'weak',
  stabilityScore: 0.1,
  updatedAt: now - 1000
};
writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [strongNode, weakNode]);
writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [{
  ...buildEmbeddingIdentity(strongNode),
  embedding: [1, 0, 0],
  model: 'test-embedding',
  updatedAt: now
}, {
  ...buildEmbeddingIdentity(weakNode),
  embedding: [0, 1, 0],
  model: 'test-embedding',
  updatedAt: now
}]);

module.exports = (async () => {
  const queryResult = await queryMemory({
    userId: 'u_prompt_vector',
    query: 'where did we put the backup charger',
    facet: 'default',
    topK: 4
  });
  assert.ok(queryResult.results.some((item) => item.id === 'node_prompt_strong'), 'strong semantic memory should be retrieved');

  const memoryContext = await buildMemoryContextAsync('u_prompt_vector', 'where did we put the backup charger', {
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    topK: 4
  });
  assert.ok(String(memoryContext.memoryForPrompt || '').includes('obsidian case'), 'retrieved memory must enter memoryForPrompt');
  assert.ok(String(memoryContext.promptRetrievedMemoryText || '').includes('obsidian case'), 'retrieved memory must enter promptRetrievedMemoryText');
  assert.ok(!String(memoryContext.promptRetrievedMemoryText || '').includes('temporary snack'), 'weak memory must not displace protected strong evidence');
  assert.strictEqual(memoryContext.diagnostics.memoryTrace.retrieval_path, 'v3');
  assert.ok(memoryContext.diagnostics.memoryTrace.injected_block_ids.includes('retrieved_memory_lite'));
  assert.ok(memoryContext.diagnostics.memoryTrace.top_hit_ids.includes('node_prompt_strong'));

  const prompt = await buildDynamicPrompt(
    { level: 'friend', points: 9 },
    'u_prompt_vector',
    'where did we put the backup charger',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext,
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.9, priority: 20, reason: 'planner miss' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  const retrievedBlock = prompt.promptSnapshot.assembledBlocks.find((item) => item.id === 'retrieved_memory_lite');
  assert.ok(retrievedBlock, 'runtime must force retrieved memory block into final prompt');
  assert.ok(String(retrievedBlock.content || '').includes('obsidian case'));
  assert.ok(prompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'retrieved_memory_lite'));

  const legacyIds = addMemoryItemsBatch([{
    userId: 'u_legacy_prompt',
    type: 'fact',
    text: 'legacy unified fallback remembers the brass adapter lives in the blue tin',
    source: 'test',
    sourceKind: 'explicit',
    confidence: 1,
    status: 'active'
  }]);
  assert.strictEqual(legacyIds.length, 1);
  const previousV3Enabled = process.env.MEMORY_V3_ENABLED;
  const config = require('../config');
  process.env.MEMORY_V3_ENABLED = 'false';
  config.MEMORY_V3_ENABLED = false;
  const legacyContext = await buildMemoryContextAsync('u_legacy_prompt', 'where is the brass adapter', {
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    topK: 4
  });
  assert.strictEqual(legacyContext.diagnostics.memoryTrace.retrieval_path, 'legacy_unified');
  assert.ok(String(legacyContext.memoryForPrompt || '').includes('blue tin'), 'legacy unified fallback must enter memoryForPrompt');
  assert.ok(legacyContext.diagnostics.memoryTrace.injected_block_ids.includes('retrieved_memory_lite'));
  process.env.MEMORY_V3_ENABLED = previousV3Enabled;
  config.MEMORY_V3_ENABLED = true;

  console.log('memoryVectorPromptGuarantee.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
