const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-forgetting-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_FORGETTING_CURVE_ENABLED = 'true';
process.env.MEMORY_REHEARSAL_ENABLED = 'true';
process.env.MEMORY_RECALL_TOUCH_ENABLED = 'true';
process.env.MEMORY_RAG_TRACK_ACCESS = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_STRICT_PROMPT_INJECTION_ENABLED = 'true';
process.env.MEMORY_STRONG_RECALL_MIN_SCORE = '0.2';
fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));

const {
  addMemoryItemsBatch,
  retrieveUnifiedMemories,
  getMemoryItems,
  rebuildMemoryIndex,
  touchAccessStats
} = require('../utils/vectorMemory');
const { buildMemoryContext } = require('../utils/memoryContext');

const old = Date.now() - (365 * 24 * 3600 * 1000);
addMemoryItemsBatch([
  {
    id: 'stable_identity_memory',
    userId: 'u_forget',
    type: 'identity',
    text: 'identity: user is a careful vibe coding beginner',
    source: 'test',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 0.95,
    updatedAt: old,
    lastConfirmedAt: old,
    weight: 1.4
  },
  {
    id: 'old_topic_memory',
    userId: 'u_forget',
    type: 'topic',
    text: 'recent topic: temporary snack conversation',
    source: 'test',
    sourceKind: 'extractor',
    status: 'active',
    confidence: 0.9,
    updatedAt: old,
    lastConfirmedAt: old,
    weight: 1
  }
]);
rebuildMemoryIndex();

const hits = retrieveUnifiedMemories('u_forget', 'careful vibe coding beginner identity', 8, { minScore: 0.01 });
const stable = hits.find((hit) => hit.id === 'stable_identity_memory');
assert.ok(stable, 'stable identity should be recalled');
assert.ok(typeof stable.decayScore === 'number', 'decay score should be exposed');
assert.ok(typeof stable.memoryStrength === 'number', 'memory strength should be exposed');
assert.ok(stable.decayScore > 0.9, 'stable identity should retain high strength');

const before = getMemoryItems('u_forget').find((item) => item.text.includes('careful vibe coding beginner'));
const beforeLastRecalledAt = Number(before.lastRecalledAt || 0);
const beforeRecallCount = Number(before.recallCount || 0);
const beforeStabilityScore = Number(before.stabilityScore || 0);
touchAccessStats('u_forget', [before.id]);
const after = getMemoryItems('u_forget').find((item) => item.id === before.id);
assert.ok(Number(after.lastRecalledAt || 0) >= beforeLastRecalledAt, 'touch should update lastRecalledAt');
assert.ok(Number(after.recallCount || 0) > beforeRecallCount, 'touch should increment recallCount');
assert.ok(Number(after.stabilityScore || 0) > beforeStabilityScore, 'touch should raise stabilityScore');

const ctx = buildMemoryContext('u_forget', 'careful vibe coding beginner identity', { topK: 8, minScore: 0.01 });
const traceHit = ctx.diagnostics.memoryTrace.hits.find((hit) => String(hit.preview || '').includes('careful vibe coding beginner')); 
assert.ok(traceHit, 'trace should include recalled memory');
assert.ok(typeof traceHit.decayScore === 'number', 'trace should expose decayScore');
assert.ok(typeof traceHit.rehearsalBoost === 'number', 'trace should expose rehearsalBoost');
assert.ok(traceHit.finalTier, 'trace should expose finalTier');

console.log('memoryForgettingCurve.test.js passed');