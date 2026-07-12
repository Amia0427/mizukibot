const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const result = spawnSync(process.execPath, ['scripts/lint.js', '--report-json'], {
  cwd: root,
  encoding: 'utf8'
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);

function collectChunks(dir) {
  const chunks = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(...collectChunks(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.chunk.js')) {
      chunks.push(path.relative(root, absolutePath).split(path.sep).join('/'));
    }
  }
  return chunks;
}

const discoveredChunks = ['api', 'core', 'src', 'utils', 'web']
  .flatMap((directory) => collectChunks(path.join(root, directory)))
  .sort();
assert.strictEqual(report.version, 1);
assert.strictEqual(report.status, 'pass');
assert.deepStrictEqual(report.chunks.map((item) => item.file), discoveredChunks);
assert.ok(report.chunks.every((item) => (
  item.validation === 'passed'
  && ['entrypoint', 'standalone'].includes(item.coverage)
  && item.error === null
)));
assert.ok(report.entrypoints.every((entrypoint) => (
  entrypoint.validation === 'passed'
  && entrypoint.missingChunks.length === 0
  && entrypoint.error === null
)));
assert.deepStrictEqual(report.errors, []);
assert.strictEqual(report.summary.discoveredChunks, discoveredChunks.length);
assert.strictEqual(
  report.summary.entrypointCovered + report.summary.standaloneCovered,
  report.summary.discoveredChunks
);
assert.strictEqual(report.summary.uncovered, 0);
assert.strictEqual(report.summary.failed, 0);
assert.strictEqual(report.summary.skipped, 0);

console.log('lintChunkEntrypoints.test.js passed');
