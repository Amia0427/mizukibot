const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-file-import-'));
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

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const importFile = path.join(tempRoot, 'memory-notes.md');
fs.writeFileSync(importFile, [
  '# 饮品偏好',
  '',
  '用户长期喜欢冰茉莉花茶，晚上学习时也会喝。',
  '',
  '# 项目偏好',
  '',
  '用户希望记忆系统导入文档时保留标题和 chunk index。'
].join('\n'), 'utf8');

const { importMemoryFile, splitMemoryImportChunks } = require('../utils/memory-v3/fileImport');
const { clearProjectionReadCache, loadMemoryNodes } = require('../utils/memory-v3/storage');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  const chunks = splitMemoryImportChunks(fs.readFileSync(importFile, 'utf8'), {
    extension: '.md',
    maxChunkChars: 400
  });
  assert.strictEqual(chunks.length, 2, 'markdown headings should become import chunks');
  assert.ok(chunks[0].text.includes('饮品偏好'));

  const dryRun = await importMemoryFile({
    userId: 'u_import',
    filePath: importFile,
    category: 'preference',
    tags: ['doc', 'tea'],
    dryRun: true
  });
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.events.length, 2);
  assert.strictEqual(dryRun.events[0].payload.sourceKind || dryRun.events[0].sourceKind, 'file_import');
  assert.strictEqual(dryRun.events[0].payload.chunkIndex, 0);

  const first = await importMemoryFile({
    userId: 'u_import',
    filePath: importFile,
    category: 'preference',
    tags: ['doc', 'tea'],
    scheduleEmbeddingBackfill: false
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.chunks, 2);
  assert.strictEqual(first.created, 2);

  clearProjectionReadCache();
  const nodes = loadMemoryNodes();
  const imported = nodes.filter((item) => item.source === 'file_import');
  assert.strictEqual(imported.length, 2);
  assert.ok(imported.every((item) => item.category === 'preference'));
  assert.ok(imported.every((item) => item.tags.includes('tea')));
  assert.ok(imported.every((item) => item.intent === 'bulk_import'));
  assert.ok(imported.every((item) => item.privacyLevel === 'private'));

  const recall = await queryMemory({
    userId: 'u_import',
    query: '用户喜欢什么茶',
    facet: 'preference',
    category: 'preference',
    topK: 5
  });
  assert.ok(recall.results.some((item) => item.source === 'personal' && item.text.includes('冰茉莉花茶')));

  const second = await importMemoryFile({
    userId: 'u_import',
    filePath: importFile,
    category: 'preference',
    tags: ['doc', 'tea'],
    scheduleEmbeddingBackfill: false
  });
  assert.strictEqual(second.updated, 2, 'repeat import should version-update existing chunks');
  clearProjectionReadCache();
  const activeImported = loadMemoryNodes().filter((item) => item.source === 'file_import' && item.status !== 'archived');
  assert.strictEqual(activeImported.length, 2, 'repeat import should keep active chunk count stable');

  console.log('memoryV3FileImport.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
