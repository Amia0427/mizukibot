const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-trace-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_STRICT_PROMPT_INJECTION_ENABLED = 'true';
process.env.MEMORY_STRONG_RECALL_MIN_SCORE = '0.2';
process.env.MEMORY_WEAK_RECALL_MIN_SCORE = '0.05';
process.env.MEMORY_RAG_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));

const { addMemoryItemsBatch, rebuildMemoryIndex } = require('../utils/vectorMemory');
const { buildMemoryContext } = require('../utils/memoryContext');

addMemoryItemsBatch([
  {
    userId: 'u_trace',
    type: 'fact',
    text: 'dragonfruit password reminder strong-anchor',
    source: 'test',
    sourceKind: 'explicit',
    status: 'active',
    confidence: 1,
    weight: 2
  },
  {
    userId: 'u_trace',
    type: 'fact',
    text: 'background-only weak unrelated note',
    source: 'test',
    sourceKind: 'extractor',
    status: 'active',
    confidence: 0.9,
    weight: 0.2
  }
]);
rebuildMemoryIndex();

const ctx = buildMemoryContext('u_trace', 'dragonfruit strong-anchor', { topK: 8 });
assert.ok(ctx.diagnostics && ctx.diagnostics.memoryTrace, 'memory trace should be present');
assert.ok(Array.isArray(ctx.diagnostics.memoryTrace.hits), 'trace hits should be listed');
assert.ok(ctx.diagnostics.memoryTrace.injectedApproxTokens >= 0, 'trace should include token estimate');
assert.ok(String(ctx.memoryForPrompt || '').includes('dragonfruit password reminder'), 'strong memory should be injected');

console.log('memoryTraceDiagnostics.test.js passed');