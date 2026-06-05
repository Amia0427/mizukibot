const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-profile-trace-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_RAG_ENABLED = 'false';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_PROFILE_TRACE_ITEMS_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { buildStableProfileText } = require('../utils/memoryProfileSurface');
const { buildMemoryContext } = require('../utils/memoryContext');

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'trace-like-explicit',
    type: 'memory_confirmed',
    ts: 1000,
    userId: 'u_trace',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    text: '喜欢可审计画像',
    confidence: 1,
    payload: { fieldKey: 'preference_like', type: 'like', extractionClass: 'stable_profile_candidate' }
  });

  materializeMemoryViews({ force: true });
  const surface = buildStableProfileText('u_trace', { question: '普通聊天' });
  assert.strictEqual(surface.source, 'profile_journal_db');
  assert.ok(surface.text.includes('喜欢可审计画像'));
  assert.ok(surface.traceItems.some((item) => item.text === '喜欢可审计画像' && item.sourceEventIds.includes('trace-like-explicit')));
  assert.ok(surface.traceItems.some((item) => item.confidence === 1 && item.evidenceCount >= 1));

  const ctx = buildMemoryContext('u_trace', '普通聊天', { ragEnabled: false });
  assert.ok(ctx.diagnostics.memoryTrace.profile_trace_items.some((item) => item.text === '喜欢可审计画像'));
  assert.strictEqual(ctx.diagnostics.memoryTrace.profile_source, 'profile_journal_db');

  console.log('memoryProfileTrace.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
