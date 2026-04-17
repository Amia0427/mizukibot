const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-conflict-'));
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

addMemoryItemsBatch([
  {
    userId: 'u_conflict',
    type: 'like',
    text: '喜欢被叫猪猪',
    source: 'legacy',
    sourceKind: 'legacy',
    status: 'candidate',
    confidence: 0.82,
    conflictKey: 'u_conflict|preference|猪猪',
    updatedAt: 1000
  },
  {
    userId: 'u_conflict',
    type: 'dislike',
    text: '不喜欢被叫猪猪',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1,
    conflictKey: 'u_conflict|preference|猪猪',
    updatedAt: 2000
  }
]);
rebuildMemoryIndex();

const hits = retrieveUnifiedMemories('u_conflict', '猪猪 称呼 偏好', 8, {
  groupId: 'g1',
  topRouteType: 'direct_chat',
  routePolicyKey: 'chat/default'
});

assert.ok(hits.some((hit) => hit.text.includes('不喜欢被叫猪猪')), 'expected active dislike winner');
assert.ok(!hits.some((hit) => hit.text === '喜欢被叫猪猪'), 'expected loser to be suppressed');

const ctx = buildMemoryContext('u_conflict', '你喜欢别人叫你猪猪吗', {
  groupId: 'g1',
  topRouteType: 'direct_chat',
  routePolicyKey: 'chat/default'
});
assert.ok(String(ctx.memoryForPrompt || '').includes('不喜欢被叫猪猪'));
assert.ok(!String(ctx.memoryForPrompt || '').includes('\n喜欢被叫猪猪'));

console.log('memoryConflictFiltering.test.js passed');
