'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const roots = ['api', 'core', 'src', 'utils'];
const allowed = new Set([
  'src/memory/vector/index.js',
  'src/memory/vector/retrieval.js',
  'src/memory/vector/retrieval-runtime.js',
  'src/memory/vector/stats.js',
  'src/memory/vector/store.js',
  'src/memory/vector/store-runtime.js',
  'src/memory/vector/write.js',
  'src/memory/vector/write-runtime.js',
  'src/memory/vector/normalize.chunk.js',
  'src/memory/vector/retrieval-stats.chunk.js',
  'src/memory/vector/write.chunk.js',
  'src/memory/vector/archive-write-helpers.chunk.js',
  'utils/vectorMemory.js',
  'utils/memory-v3/legacyCompat.js',
  'utils/memory-v3/legacyShadow.js',
  'utils/memory-v3/migration.js',
  'utils/memoryProjection/migration.js'
]);

function listJavaScriptFiles(dir) {
  const output = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) output.push(fullPath);
    }
  }
  return output;
}

const violations = roots
  .flatMap((name) => listJavaScriptFiles(path.join(root, name)))
  .map((file) => ({
    file,
    relative: path.relative(root, file).replace(/\\/g, '/'),
    source: fs.readFileSync(file, 'utf8')
  }))
  .filter((entry) => !allowed.has(entry.relative))
  .filter((entry) => /(?:require\s*\(\s*['"][^'"]*vectorMemory['"]\s*\)|\bvectorMemory\s*\.)/.test(entry.source))
  .map((entry) => entry.relative)
  .sort();

assert.deepStrictEqual(violations, [], `legacy vector store consumers remain:\n${violations.join('\n')}`);

const shadowSource = fs.readFileSync(path.join(root, 'utils', 'memory-v3', 'legacyShadow.js'), 'utf8');
assert.ok(shadowSource.includes('retrieveUnifiedMemoriesAsync'));
assert.ok(!/\b(?:add|save|write|rebuild|remember)Memory/i.test(shadowSource));

console.log('memoryV3ConsumerBoundary.test.js passed');
