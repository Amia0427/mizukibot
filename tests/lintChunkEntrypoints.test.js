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
const legacyContextChunks = [
  'api/runtimeV2/context/service-core.chunk.js',
  'api/runtimeV2/context/dynamic-plan.chunk.js',
  'api/runtimeV2/context/cache-blocks.chunk.js',
  'api/runtimeV2/context/prompt-inputs.chunk.js',
  'api/runtimeV2/context/render-helpers.chunk.js',
  'api/runtimeV2/context/base-dynamic-prompt.chunk.js',
  'api/runtimeV2/context/base-dynamic-prompt-02.chunk.js',
  'api/runtimeV2/context/dynamic-prompt.chunk.js',
  'api/runtimeV2/context/dynamic-prompt-02.chunk.js',
  'api/runtimeV2/context/vision.chunk.js'
];
const legacyMessageHandlerChunks = [
  'core/messageHandler.imports.chunk.js',
  'core/messageHandler.prompts.chunk.js',
  'core/messageHandler.direct-session.chunk.js',
  'core/messageHandler.route-capture.chunk.js',
  'core/messageHandler.runtime.chunk.js',
  'core/messageHandler.runtime-02.chunk.js',
  'core/messageHandler.runtime-03.chunk.js',
  'core/messageHandler.runtime-04.chunk.js',
  'core/messageHandler.runtime-05.chunk.js',
  'core/messageHandler.runtime-06.chunk.js',
  'core/messageHandler.exports.chunk.js'
];
const expectedChunkRecords = [
  'api/runtimeV2/context (legacy retained context chunks)',
  'core (legacy retained message handler chunks)',
  ...discoveredChunks.filter((file) => (
    !legacyContextChunks.includes(file) && !legacyMessageHandlerChunks.includes(file)
  ))
].sort();
assert.strictEqual(report.version, 1);
assert.strictEqual(report.status, 'pass');
assert.deepStrictEqual(report.chunks.map((item) => item.file), expectedChunkRecords);
assert.ok(report.chunks.every((item) => (
  item.validation === 'passed'
  && ['entrypoint', 'standalone', 'legacy-retained-combined'].includes(item.coverage)
  && item.error === null
)));
const legacyRecords = report.chunks.filter((item) => item.coverage === 'legacy-retained-combined');
assert.strictEqual(legacyRecords.length, 2);
assert.deepStrictEqual(
  legacyRecords.find((item) => item.file.startsWith('api/runtimeV2/context')).chunks,
  legacyContextChunks
);
assert.deepStrictEqual(
  legacyRecords.find((item) => item.file.startsWith('core ')).chunks,
  legacyMessageHandlerChunks
);
assert.ok(legacyRecords.every((item) => item.execution === 'not-run'));
assert.ok(report.entrypoints.every((entrypoint) => {
  if (entrypoint.name === 'src/runtime-v2/context' || entrypoint.name === 'src/message/handler') {
    return entrypoint.validation === 'not-run'
      && entrypoint.missingChunks.length === 0
      && entrypoint.error === null;
  }
  return entrypoint.validation === 'passed'
    && entrypoint.missingChunks.length === 0
    && entrypoint.error === null;
}));
assert.deepStrictEqual(report.errors, []);
assert.strictEqual(report.summary.discoveredChunks, expectedChunkRecords.length);
assert.strictEqual(
  report.summary.entrypointCovered
    + report.summary.legacyRetainedCovered
    + report.summary.standaloneCovered,
  report.summary.discoveredChunks
);
assert.strictEqual(report.summary.uncovered, 0);
assert.strictEqual(report.summary.failed, 0);
assert.strictEqual(report.summary.skipped, 0);

console.log('lintChunkEntrypoints.test.js passed');
