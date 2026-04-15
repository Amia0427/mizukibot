const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-conflict-stable-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const { addMemoryItemsBatch, rebuildMemoryIndex, retrieveUnifiedMemories } = require('../utils/vectorMemory');
const { buildMemoryContext } = require('../utils/memoryContext');

const conflictKey = 'u_conflict|preference|nickname';

addMemoryItemsBatch([
  {
    userId: 'u_conflict',
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
    userId: 'u_conflict',
    type: 'dislike',
    text: '不喜欢这个昵称',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1,
    conflictKey,
    updatedAt: 2000
  }
]);
rebuildMemoryIndex();

const hits = retrieveUnifiedMemories('u_conflict', '昵称 偏好 称呼', 8, {
  groupId: 'g1',
  topRouteType: 'direct_chat',
  routePolicyKey: 'chat/default'
});

assert.ok(hits.some((hit) => hit.type === 'dislike' && hit.conflictKey === conflictKey));
assert.ok(!hits.some((hit) => hit.type === 'like' && hit.conflictKey === conflictKey));

const ctx = buildMemoryContext('u_conflict', '你喜欢别人这样叫你吗', {
  groupId: 'g1',
  topRouteType: 'direct_chat',
  routePolicyKey: 'chat/default'
});

assert.ok(Array.isArray(ctx.hits));
assert.ok(ctx.hits.some((hit) => hit.type === 'dislike' && hit.conflictKey === conflictKey));
assert.ok(!ctx.hits.some((hit) => hit.type === 'like' && hit.conflictKey === conflictKey));

console.log('memoryConflictFilteringStable.test.js passed');
