const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-role-log-paths-'));
const missingEnvFile = path.join(tempDir, 'missing.env');

function loadPaths(role, overrides = {}) {
  const script = "const c=require('./config'); process.stdout.write(JSON.stringify({perf:c.PERF_LOG_FILE,resource:c.RESOURCE_SNAPSHOT_FILE}));";
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_KEY: 'test-key',
      DATA_DIR: tempDir,
      MIZUKIBOT_ENV_FILE: missingEnvFile,
      MIZUKIBOT_RUNTIME_ROLE: role,
      PERF_LOG_FILE: '',
      RESOURCE_SNAPSHOT_FILE: '',
      ...overrides
    }
  }));
}

const main = loadPaths('main');
const worker = loadPaths('post_reply_worker');
assert.strictEqual(main.perf, path.join(tempDir, 'perf-events-main.jsonl'));
assert.strictEqual(main.resource, path.join(tempDir, 'resource-snapshots-main.jsonl'));
assert.strictEqual(worker.perf, path.join(tempDir, 'perf-events-post-reply-worker.jsonl'));
assert.strictEqual(worker.resource, path.join(tempDir, 'resource-snapshots-post-reply-worker.jsonl'));
assert.notStrictEqual(main.resource, worker.resource);

const explicitResource = path.join(tempDir, 'explicit-resource.jsonl');
assert.strictEqual(loadPaths('main', { RESOURCE_SNAPSHOT_FILE: explicitResource }).resource, explicitResource);

console.log('runtimeRoleLogPaths.test.js passed');
