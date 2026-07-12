const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

for (const relativePath of [
  'utils/perfRuntime.js',
  'core/messageTelemetry.js',
  'core/napcatLogFollower.js',
  'core/dailyShareEngine.core.chunk.js'
]) {
  assert.ok(read(relativePath).includes('retentionManaged: true'), `${relativePath} must explicitly opt into log retention`);
}

for (const relativePath of [
  'utils/memory-v3/events.js',
  'utils/memory-v3/helpers.js',
  'utils/dailyJournal/jsonLines.js',
  'utils/selfImprovement/storeFiles.js'
]) {
  assert.ok(!read(relativePath).includes('retentionManaged: true'), `${relativePath} is a state source and must not opt into log retention`);
}

console.log('logRetentionCallsites.test.js passed');
