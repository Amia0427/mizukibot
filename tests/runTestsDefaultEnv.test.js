const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { DEFAULT_TEST_TEMP_ROOT } = require('../scripts/run-tests');

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
      MEMORY_CLI_RERANK_ENABLED: '',
      NAPCAT_HTTP_API_BASE_URL: ''
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
const expectedTempRoot = path.resolve(process.env.TEST_TEMP_ROOT || DEFAULT_TEST_TEMP_ROOT);
assert.strictEqual(path.resolve(payload.env.TEST_TEMP_ROOT), expectedTempRoot);
assert.strictEqual(path.resolve(payload.env.TEMP), expectedTempRoot);
assert.strictEqual(path.resolve(payload.env.TMP), expectedTempRoot);
assert.strictEqual(path.resolve(payload.env.TMPDIR), expectedTempRoot);
assert.strictEqual(payload.env.MODEL_TLS_IMPERSONATION_ENABLED, 'false');
assert.strictEqual(payload.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED, 'false');
assert.strictEqual(payload.env.MEMORY_CLI_RERANK_ENABLED, 'false');
assert.strictEqual(payload.env.NAPCAT_HTTP_API_BASE_URL, 'http://127.0.0.1:1');
assert.strictEqual(payload.config.MODEL_TLS_IMPERSONATION_ENABLED, false);
assert.strictEqual(payload.config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED, false);
assert.strictEqual(payload.config.MEMORY_CLI_RERANK_ENABLED, false);
assert.strictEqual(payload.config.NAPCAT_HTTP_API_BASE_URL, 'http://127.0.0.1:1');
assert.strictEqual(payload.transport.tlsImpersonationEnabled, false);
assert.strictEqual(payload.transport.tlsImpersonationStreamEnabled, false);

console.log('runTestsDefaultEnv.test.js passed');
