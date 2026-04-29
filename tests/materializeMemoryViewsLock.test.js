const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-materialize-memory-lock-'));
process.env.DATA_DIR = tempRoot;
process.env.API_KEY = 'test-key';
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'materialize.lock');
process.env.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS = '600000';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE, JSON.stringify({
  pid: process.pid,
  acquiredAt: Date.now()
}), 'utf8');

const { materializeMemoryViews } = require('../utils/memory-v3/materializer');

const result = materializeMemoryViews({ force: true });
assert.strictEqual(result.deferred, true);
assert.strictEqual(result.reason, 'materialize_lock_busy');
assert.ok(fs.existsSync(process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE));

console.log('materializeMemoryViewsLock tests passed');
