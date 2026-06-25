const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const probe = spawnSync(
  process.execPath,
  ['scripts/run-tests.js', 'tests/fixtures/run-tests-env-probe.js'],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      MODEL_TLS_IMPERSONATION_ENABLED: '',
      MODEL_TLS_IMPERSONATION_STREAM_ENABLED: '',
      MEMORY_CLI_RERANK_ENABLED: ''
    },
    encoding: 'utf8'
  }
);

assert.strictEqual(probe.status, 0, probe.stderr || probe.stdout);

const payloadLine = String(probe.stdout || '')
  .split(/\r?\n/)
  .find((line) => line.trim().startsWith('{"env":'));
assert.ok(payloadLine, probe.stdout);

const payload = JSON.parse(payloadLine);
assert.strictEqual(payload.env.MODEL_TLS_IMPERSONATION_ENABLED, 'false');
assert.strictEqual(payload.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED, 'false');
assert.strictEqual(payload.env.MEMORY_CLI_RERANK_ENABLED, 'false');
assert.strictEqual(payload.config.MODEL_TLS_IMPERSONATION_ENABLED, false);
assert.strictEqual(payload.config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED, false);
assert.strictEqual(payload.config.MEMORY_CLI_RERANK_ENABLED, false);
assert.strictEqual(payload.transport.tlsImpersonationEnabled, false);
assert.strictEqual(payload.transport.tlsImpersonationStreamEnabled, false);

console.log('runTestsDefaultEnv.test.js passed');
