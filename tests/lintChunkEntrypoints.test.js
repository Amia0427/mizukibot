const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const result = spawnSync(process.execPath, ['scripts/lint.js'], {
  cwd: root,
  encoding: 'utf8'
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
assert.ok(result.stdout.includes('[lint] ok   api\\runtimeV2\\context\\dynamic-prompt.chunk.js (via src/runtime-v2/context)')
  || result.stdout.includes('[lint] ok   api/runtimeV2/context/dynamic-prompt.chunk.js (via src/runtime-v2/context)'));
assert.ok(result.stdout.includes('[lint] ok   src/runtime-v2/context'));
assert.ok(result.stdout.includes('[lint] ok   src/message/handler'));
assert.ok(!result.stdout.includes('[lint] skip'));

console.log('lintChunkEntrypoints.test.js passed');
