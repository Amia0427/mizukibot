const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-nocturne-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_SESSION_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json');
process.env.MEMORY_V3_PROFILE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
process.env.MEMORY_V3_SCOPE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'scope_projection.json');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_CLI_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { clearProjectionReadCache, loadMemoryNodes } = require('../utils/memory-v3/storage');
const { runMemoryCli } = require('../utils/memoryCli');
const { searchMemoryUris } = require('../utils/memory-v3/uriResolver');

async function seedMemory(id, status, text) {
  await appendMemoryEvent({
    id,
    type: status === 'candidate' ? 'memory_candidate_extracted' : 'memory_confirmed',
    userId: 'u_shell',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status,
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: id,
    text,
    confidence: 0.95,
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      category: 'preference',
      tags: ['tea']
    }
  });
}

module.exports = (async () => {
  await seedMemory('active-tea', 'active', '喜欢冰茉莉花茶');
  await seedMemory('candidate-cookie', 'candidate', '喜欢海盐曲奇');
  await seedMemory('candidate-reject', 'candidate', '临时喜欢不存在的口味');
  materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  clearProjectionReadCache();

  const read = await runMemoryCli('mem read core://user/u_shell/memory/active-tea', { userId: 'u_shell' });
  assert.strictEqual(read.ok, true);
  assert.ok(String(read.text || '').includes('喜欢冰茉莉花茶'));

  const alias = await runMemoryCli('mem alias add --uri "core://user/u_shell/favorite-tea" --target "core://user/u_shell/memory/active-tea"', { userId: 'u_shell' });
  assert.strictEqual(alias.ok, true);
  const aliasRead = await runMemoryCli('mem read core://user/u_shell/favorite-tea', { userId: 'u_shell' });
  assert.strictEqual(aliasRead.ok, true);
  assert.strictEqual(aliasRead.alias.targetUri, 'core://user/u_shell/memory/active-tea');

  const isolatedAliasRead = await runMemoryCli('mem read --namespace other core://user/u_shell/favorite-tea', { userId: 'u_shell' });
  assert.strictEqual(isolatedAliasRead.ok, false);

  const trigger = await runMemoryCli('mem trigger add --uri "core://user/u_shell/memory/active-tea" --keyword "茉莉"', { userId: 'u_shell' });
  assert.strictEqual(trigger.ok, true);
  const glossary = await runMemoryCli('mem read system://glossary', { userId: 'u_shell' });
  assert.strictEqual(glossary.ok, true);
  assert.ok(String(glossary.text || '').includes('茉莉 -> core://user/u_shell/memory/active-tea'));
  const triggerSearch = searchMemoryUris('茉莉', { userId: 'u_shell' });
  assert.ok(triggerSearch.items.some((item) => item.uri === 'core://user/u_shell/memory/active-tea'));

  const boot = await runMemoryCli('mem boot --query "茉莉"', { userId: 'u_shell' });
  assert.strictEqual(boot.ok, true);
  assert.ok(String(boot.text || '').includes('茉莉') || boot.results.length > 0);

  const review = await runMemoryCli('mem review list --status candidate --limit 10', { userId: 'u_shell' });
  assert.strictEqual(review.ok, true);
  assert.ok(review.changesets.some((item) => item.id === 'candidate-cookie'));

  const accepted = await runMemoryCli('mem review accept --id candidate-cookie', { userId: 'u_shell' });
  assert.strictEqual(accepted.ok, true);
  clearProjectionReadCache();
  assert.strictEqual(loadMemoryNodes().find((item) => item.id === 'candidate-cookie').status, 'active');

  const rejected = await runMemoryCli('mem review reject --id candidate-reject', { userId: 'u_shell' });
  assert.strictEqual(rejected.ok, true);
  clearProjectionReadCache();
  assert.ok(!loadMemoryNodes().some((item) => item.id === 'candidate-reject'));

  console.log('memoryV3NocturneShell.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
