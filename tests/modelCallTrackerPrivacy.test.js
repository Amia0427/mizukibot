'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

const snapshot = { ...process.env };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-model-call-privacy-'));
try {
  process.env.DATA_DIR = tempDir;
  process.env.API_KEY = 'model-call-test-key';
  process.env.REQUEST_TRACE_HASH_SECRET = 'trace-hash-test-secret';
  clearProjectCache();

  const { hashTraceIdentifier } = require('../utils/requestTrace');
  const {
    startModelCall,
    finishModelCall,
    flushModelCallLogsSync,
    resetModelCallTracker
  } = require('../utils/modelCallTracker');

  resetModelCallTracker();
  const id = startModelCall({
    requestId: 'req_model_privacy',
    userId: 'raw-user-123',
    model: 'test-model',
    provider: 'openai_compatible',
    request: { model: 'test-model', messages: [] }
  });
  finishModelCall(id, { status: 'succeeded' });
  flushModelCallLogsSync();

  const lines = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].user_id, hashTraceIdentifier('userId', 'raw-user-123'));
  assert.ok(!JSON.stringify(lines[0]).includes('raw-user-123'));
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
  clearProjectCache();
}
