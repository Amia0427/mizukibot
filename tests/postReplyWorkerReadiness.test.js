const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  inspectPostReplyWorkerReadiness,
  writePostReplyWorkerState
} = require('../utils/postReplyWorker/readiness');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-worker-readiness-'));
const stateFile = path.join(tempRoot, 'worker-state.json');
let now = Date.parse('2026-07-13T12:00:00.000Z');

writePostReplyWorkerState(stateFile, {
  stage: 'starting',
  pid: 1234,
  startedAt: '2026-07-13T11:59:00.000Z',
  heartbeatAt: new Date(now).toISOString()
});
assert.strictEqual(inspectPostReplyWorkerReadiness(stateFile, {
  now: () => now,
  isProcessAlive: () => true
}).ready, false);

writePostReplyWorkerState(stateFile, {
  stage: 'ready',
  pid: 1234,
  startedAt: '2026-07-13T11:59:00.000Z',
  heartbeatAt: new Date(now).toISOString(),
  activeCount: 0
});
const ready = inspectPostReplyWorkerReadiness(stateFile, {
  now: () => now,
  isProcessAlive: (pid) => pid === 1234,
  maxAgeMs: 60000
});
assert.strictEqual(ready.ready, true);
assert.strictEqual(ready.stage, 'ready');

now += 60001;
assert.strictEqual(inspectPostReplyWorkerReadiness(stateFile, {
  now: () => now,
  isProcessAlive: () => true,
  maxAgeMs: 60000
}).reason, 'heartbeat_stale');
assert.strictEqual(inspectPostReplyWorkerReadiness(stateFile, {
  now: () => now - 60001,
  isProcessAlive: () => false,
  maxAgeMs: 60000
}).reason, 'process_not_alive');

fs.writeFileSync(stateFile, '{broken', 'utf8');
assert.strictEqual(inspectPostReplyWorkerReadiness(stateFile).reason, 'state_invalid');
assert.strictEqual(inspectPostReplyWorkerReadiness(path.join(tempRoot, 'missing.json')).reason, 'state_missing');

writePostReplyWorkerState(stateFile, {
  stage: 'ready',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString()
});
const cliReady = spawnSync(process.execPath, ['scripts/check-post-reply-worker-ready.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    API_KEY: process.env.API_KEY || 'test-key',
    MIZUKIBOT_POST_REPLY_WORKER_STATE_FILE: stateFile,
    POST_REPLY_WORKER_READINESS_MAX_AGE_MS: '60000'
  },
  encoding: 'utf8'
});
assert.strictEqual(cliReady.status, 0, cliReady.stderr);
assert.strictEqual(JSON.parse(cliReady.stdout).ready, true);

writePostReplyWorkerState(stateFile, {
  stage: 'draining',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString()
});
const cliDraining = spawnSync(process.execPath, ['scripts/check-post-reply-worker-ready.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    API_KEY: process.env.API_KEY || 'test-key',
    MIZUKIBOT_POST_REPLY_WORKER_STATE_FILE: stateFile
  },
  encoding: 'utf8'
});
assert.strictEqual(cliDraining.status, 1);

console.log('postReplyWorkerReadiness.test.js passed');
