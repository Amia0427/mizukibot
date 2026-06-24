const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function createMemoryV3TempEnv(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = tempRoot;
  process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
  process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
  process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
  process.env.MEMORY_V3_ENABLED = 'true';
  process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

  // These unit tests validate local Memory V3 behavior only. Turning off
  // rerank/vector backends keeps them from opening transport sockets.
  process.env.MEMORY_RERANK_ENABLED = 'false';
  process.env.MEMORY_EMBEDDING_ENABLED = 'false';
  process.env.MEMORY_EMBEDDING_MODEL = '';
  process.env.MEMORY_EMBEDDING_API_BASE_URL = '';
  process.env.MEMORY_EMBEDDING_API_KEY = '';
  process.env.MEMORY_VECTOR_STORE = 'local_jsonl';
  process.env.MEMORY_LANCEDB_READ_ENABLED = 'false';
  process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'false';
  process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
  process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';

  fs.mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function collectUnexpectedActiveHandles() {
  if (typeof process._getActiveHandles !== 'function') return [];
  return process._getActiveHandles().filter((handle) => {
    if (!handle || !handle.constructor) return false;
    if (handle.constructor.name !== 'Socket') return true;
    return handle.fd !== 1 && handle.fd !== 2;
  });
}

async function assertNoUnexpectedHandles(options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs || 0) || 0);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const unexpected = collectUnexpectedActiveHandles();
  assert.deepStrictEqual(
    unexpected.map((handle) => handle.constructor && handle.constructor.name),
    [],
    `unexpected active handles: ${unexpected.map((handle) => handle.constructor && handle.constructor.name).join(', ')}`
  );
}

module.exports = {
  assertNoUnexpectedHandles,
  createMemoryV3TempEnv
};
