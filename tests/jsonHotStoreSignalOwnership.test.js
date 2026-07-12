const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJsonHotStore } = require('../utils/jsonHotStore');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-hot-store-signal-'));
const beforeSigint = process.listeners('SIGINT');
const beforeSigterm = process.listeners('SIGTERM');

try {
  createJsonHotStore(path.join(tmpDir, 'state.json'), {
    fallback: () => ({})
  });

  assert.deepStrictEqual(
    process.listeners('SIGINT'),
    beforeSigint,
    'jsonHotStore must not own SIGINT process termination'
  );
  assert.deepStrictEqual(
    process.listeners('SIGTERM'),
    beforeSigterm,
    'jsonHotStore must not own SIGTERM process termination'
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
