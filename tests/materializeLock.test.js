const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireMaterializeLock } = require('../utils/memory-v3/materializeLock');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-materialize-lock-'));
const lockFile = path.join(tempDir, 'materialize.lock');

const first = acquireMaterializeLock(lockFile);
assert.strictEqual(first.acquired, true);

const second = acquireMaterializeLock(lockFile);
assert.strictEqual(second.acquired, false);
assert.strictEqual(second.reason, 'busy');

first.release();

const third = acquireMaterializeLock(lockFile);
assert.strictEqual(third.acquired, true);
third.release();

fs.writeFileSync(lockFile, JSON.stringify({
  pid: 99999999,
  acquiredAt: Date.now()
}), 'utf8');
const stale = acquireMaterializeLock(lockFile);
assert.strictEqual(stale.acquired, true);
stale.release();

console.log('materializeLock tests passed');
