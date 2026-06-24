const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function loadConfigWithEnv(env = {}) {
  const snapshot = { ...process.env };
  const controlledKeys = [
    'API_KEY',
    'LOW_RESOURCE_MODE',
    'MIZUKIBOT_RUNTIME_ROLE',
    'LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH',
    'LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC',
    'LOW_RESOURCE_LANCEDB_HELPER_ENABLED',
    'LOW_RESOURCE_LANCEDB_HELPER_TIMEOUT_MS',
    'LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING',
    'MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START',
    'MEMORY_LOCAL_CANDIDATE_LIMIT',
    'MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE',
    'MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN',
    'MEMORY_LANCEDB_READ_ENABLED',
    'MEMORY_LANCEDB_SYNC_ENABLED',
    'MEMORY_LANCEDB_CANDIDATE_LIMIT',
    'MEMORY_LANCEDB_TIMEOUT_MS',
    'MEMORY_RERANK_ENABLED',
    'MEMORY_CLI_RERANK_ENABLED',
    'MEMORY_RERANK_MAX_CANDIDATES',
    'MEMORY_RERANK_CANDIDATE_LIMIT',
    'MEMORY_RERANK_TIMEOUT_MS',
    'MEMORY_RERANK_TIMEOUT_FLOOR_MS',
    'MEMORY_RERANK_MAX_DOC_CHARS',
    'PERSONA_WORLDBOOK_EMBEDDING_ENABLED',
    'PERSONA_WORLDBOOK_EMBEDDING_BACKFILL_MAX_PER_RUN',
    'PERSONA_WORLDBOOK_LEXICAL_LIMIT',
    'PERSONA_WORLDBOOK_SEMANTIC_LIMIT',
    'PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT',
    'PERSONA_WORLDBOOK_RERANK_ENABLED',
    'PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES',
    'PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS',
    'IMAGE_MEMORY_RECALL_ENABLED',
    'IMAGE_MEMORY_OBSERVATION_LIMIT',
    'POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED',
    'POST_REPLY_WORKER_RSS_RECYCLE_MB',
    'POST_REPLY_WORKER_RSS_RECYCLE_IDLE_MS',
    'POST_REPLY_VECTOR_MAINTENANCE_ENABLED'
  ];
  try {
    for (const key of controlledKeys) delete process.env[key];
    for (const key of controlledKeys) process.env[key] = '__TEST_DEFAULT__';
    Object.assign(process.env, env);
    clearProjectCache();
    return require('../config');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
}

const mainConfig = loadConfigWithEnv({
  API_KEY: 'test-key',
  LOW_RESOURCE_MODE: 'true',
  MIZUKIBOT_RUNTIME_ROLE: 'main',
  MEMORY_LANCEDB_READ_ENABLED: 'true',
  MEMORY_LANCEDB_SYNC_ENABLED: 'true',
  MEMORY_RERANK_ENABLED: 'true',
  MEMORY_CLI_RERANK_ENABLED: 'true',
  PERSONA_WORLDBOOK_EMBEDDING_ENABLED: 'true',
  PERSONA_WORLDBOOK_RERANK_ENABLED: 'true',
  IMAGE_MEMORY_RECALL_ENABLED: 'true'
});

assert.strictEqual(mainConfig.LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH, false);
assert.strictEqual(mainConfig.LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC, false);
assert.strictEqual(mainConfig.LOW_RESOURCE_LITE_BUDGET, true);
assert.strictEqual(mainConfig.LOW_RESOURCE_LANCEDB_HELPER_ENABLED, true);
assert.strictEqual(mainConfig.LOW_RESOURCE_LANCEDB_HELPER_TIMEOUT_MS, 2500);
assert.strictEqual(mainConfig.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING, true);
assert.strictEqual(mainConfig.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START, false);
assert.strictEqual(mainConfig.MEMORY_LANCEDB_READ_ENABLED, true);
assert.strictEqual(mainConfig.MEMORY_LANCEDB_SYNC_ENABLED, true);
assert.strictEqual(mainConfig.MEMORY_RERANK_ENABLED, true);
assert.strictEqual(mainConfig.MEMORY_CLI_RERANK_ENABLED, true);
assert.strictEqual(mainConfig.PERSONA_WORLDBOOK_EMBEDDING_ENABLED, true);
assert.strictEqual(mainConfig.PERSONA_WORLDBOOK_SEMANTIC_LIMIT, 6);
assert.strictEqual(mainConfig.PERSONA_WORLDBOOK_RERANK_ENABLED, true);
assert.strictEqual(mainConfig.IMAGE_MEMORY_RECALL_ENABLED, true);
assert.strictEqual(mainConfig.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED, false);
assert.strictEqual(mainConfig.POST_REPLY_WORKER_RSS_RECYCLE_MB, 768);
assert.strictEqual(mainConfig.POST_REPLY_ENRICH_ENABLED, true);
assert.strictEqual(mainConfig.POST_REPLY_VECTOR_MAINTENANCE_ENABLED, true);

const mainLiteBudgetConfig = loadConfigWithEnv({
  API_KEY: 'test-key',
  LOW_RESOURCE_MODE: 'true',
  MIZUKIBOT_RUNTIME_ROLE: 'main',
  MEMORY_LOCAL_CANDIDATE_LIMIT: '96',
  MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE: '32',
  MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN: '128',
  MEMORY_LANCEDB_CANDIDATE_LIMIT: '64',
  MEMORY_LANCEDB_TIMEOUT_MS: '800',
  MEMORY_RERANK_MAX_CANDIDATES: '40',
  MEMORY_RERANK_CANDIDATE_LIMIT: '32',
  MEMORY_RERANK_TIMEOUT_MS: '2000',
  MEMORY_RERANK_MAX_DOC_CHARS: '900',
  PERSONA_WORLDBOOK_EMBEDDING_BACKFILL_MAX_PER_RUN: '24',
  PERSONA_WORLDBOOK_LEXICAL_LIMIT: '24',
  PERSONA_WORLDBOOK_SEMANTIC_LIMIT: '24',
  PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT: '12',
  PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES: '24',
  PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS: '2000',
  IMAGE_MEMORY_OBSERVATION_LIMIT: '20'
});

assert.strictEqual(mainLiteBudgetConfig.MEMORY_LOCAL_CANDIDATE_LIMIT, 48);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE, 8);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN, 32);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_LANCEDB_CANDIDATE_LIMIT, 16);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_LANCEDB_TIMEOUT_MS, 350);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_RERANK_MAX_CANDIDATES, 12);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_RERANK_CANDIDATE_LIMIT, 8);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_RERANK_TIMEOUT_MS, 800);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_RERANK_TIMEOUT_FLOOR_MS, 1500);
assert.strictEqual(mainLiteBudgetConfig.MEMORY_RERANK_MAX_DOC_CHARS, 420);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_EMBEDDING_BACKFILL_MAX_PER_RUN, 6);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_LEXICAL_LIMIT, 8);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_SEMANTIC_LIMIT, 6);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT, 6);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES, 8);
assert.strictEqual(mainLiteBudgetConfig.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS, 700);
assert.strictEqual(mainLiteBudgetConfig.IMAGE_MEMORY_OBSERVATION_LIMIT, 4);

const mainExplicitDisableConfig = loadConfigWithEnv({
  API_KEY: 'test-key',
  LOW_RESOURCE_MODE: 'true',
  MIZUKIBOT_RUNTIME_ROLE: 'main',
  LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH: 'true',
  LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC: 'true',
  MEMORY_LANCEDB_READ_ENABLED: 'true',
  MEMORY_LANCEDB_SYNC_ENABLED: 'true',
  PERSONA_WORLDBOOK_EMBEDDING_ENABLED: 'true',
  PERSONA_WORLDBOOK_SEMANTIC_LIMIT: '24',
  PERSONA_WORLDBOOK_RERANK_ENABLED: 'true'
});

assert.strictEqual(mainExplicitDisableConfig.LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH, true);
assert.strictEqual(mainExplicitDisableConfig.LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC, true);
assert.strictEqual(mainExplicitDisableConfig.MEMORY_LANCEDB_READ_ENABLED, false);
assert.strictEqual(mainExplicitDisableConfig.MEMORY_LANCEDB_SYNC_ENABLED, false);
assert.strictEqual(mainExplicitDisableConfig.PERSONA_WORLDBOOK_EMBEDDING_ENABLED, false);
assert.strictEqual(mainExplicitDisableConfig.PERSONA_WORLDBOOK_SEMANTIC_LIMIT, 0);
assert.strictEqual(mainExplicitDisableConfig.PERSONA_WORLDBOOK_RERANK_ENABLED, false);

const workerConfig = loadConfigWithEnv({
  API_KEY: 'test-key',
  LOW_RESOURCE_MODE: 'true',
  MIZUKIBOT_RUNTIME_ROLE: 'post_reply_worker',
  LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH: 'false',
  LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC: 'false',
  MEMORY_LANCEDB_READ_ENABLED: 'true',
  MEMORY_LANCEDB_SYNC_ENABLED: 'true',
  MEMORY_LANCEDB_CANDIDATE_LIMIT: '64',
  MEMORY_LANCEDB_TIMEOUT_MS: '800',
  MEMORY_RERANK_ENABLED: 'true',
  MEMORY_CLI_RERANK_ENABLED: 'true',
  MEMORY_RERANK_MAX_CANDIDATES: '40',
  MEMORY_RERANK_CANDIDATE_LIMIT: '32',
  MEMORY_RERANK_TIMEOUT_MS: '2000',
  PERSONA_WORLDBOOK_EMBEDDING_ENABLED: 'true',
  PERSONA_WORLDBOOK_SEMANTIC_LIMIT: '24',
  PERSONA_WORLDBOOK_RERANK_ENABLED: 'true',
  PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES: '24',
  PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS: '2000',
  IMAGE_MEMORY_RECALL_ENABLED: 'true'
});

assert.strictEqual(workerConfig.LOW_RESOURCE_DISABLE_LANCEDB_HOT_PATH, false);
assert.strictEqual(workerConfig.LOW_RESOURCE_DISABLE_WORLDBOOK_SEMANTIC, false);
assert.strictEqual(workerConfig.LOW_RESOURCE_LITE_BUDGET, false);
assert.strictEqual(workerConfig.LOW_RESOURCE_LANCEDB_HELPER_ENABLED, false);
assert.strictEqual(workerConfig.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING, false);
assert.strictEqual(workerConfig.MEMORY_LANCEDB_READ_ENABLED, true);
assert.strictEqual(workerConfig.MEMORY_LANCEDB_SYNC_ENABLED, true);
assert.strictEqual(workerConfig.MEMORY_LANCEDB_CANDIDATE_LIMIT, 64);
assert.strictEqual(workerConfig.MEMORY_LANCEDB_TIMEOUT_MS, 800);
assert.strictEqual(workerConfig.MEMORY_RERANK_ENABLED, true);
assert.strictEqual(workerConfig.MEMORY_CLI_RERANK_ENABLED, true);
assert.strictEqual(workerConfig.MEMORY_RERANK_MAX_CANDIDATES, 40);
assert.strictEqual(workerConfig.MEMORY_RERANK_CANDIDATE_LIMIT, 32);
assert.strictEqual(workerConfig.MEMORY_RERANK_TIMEOUT_MS, 2000);
assert.strictEqual(workerConfig.MEMORY_RERANK_TIMEOUT_FLOOR_MS, 1500);
assert.strictEqual(workerConfig.PERSONA_WORLDBOOK_EMBEDDING_ENABLED, true);
assert.strictEqual(workerConfig.PERSONA_WORLDBOOK_SEMANTIC_LIMIT, 24);
assert.strictEqual(workerConfig.PERSONA_WORLDBOOK_RERANK_ENABLED, true);
assert.strictEqual(workerConfig.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES, 24);
assert.strictEqual(workerConfig.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS, 2000);
assert.strictEqual(workerConfig.IMAGE_MEMORY_RECALL_ENABLED, true);
assert.strictEqual(workerConfig.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED, false);
assert.strictEqual(workerConfig.POST_REPLY_WORKER_RSS_RECYCLE_MB, 768);

console.log('lowResourceConfig.test.js passed');
