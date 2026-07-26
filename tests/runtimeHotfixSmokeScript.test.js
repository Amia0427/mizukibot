const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const command = packageJson.scripts && packageJson.scripts['smoke:runtime-hotfixes'];

const expectedTests = [
  'tests/passiveAwarenessVisualCueProbeFallback.test.js',
  'tests/napcatPacketLogConfig.test.js',
  'tests/memoryV3EventsDailyFiles.test.js',
  'tests/postReplyTaskRunner.test.js',
  'tests/postReplyWorkerRuntime.test.js',
  'tests/draftReplyToolEvidence.test.js',
  'tests/memoryWritePipeline.test.js',
  'tests/memoryV3RecallVerificationFilter.test.js',
  'tests/postReplyVectorWatchdog.test.js'
];

assert.ok(command, 'runtime hotfix smoke script should exist');
assert.ok(command.startsWith('node scripts/run-tests.js '), 'runtime hotfix smoke should reuse the local test runner');
assert.ok(!command.includes('npm test'), 'runtime hotfix smoke should not expand to the full test suite');

const actualTests = command
  .slice('node scripts/run-tests.js '.length)
  .trim()
  .split(/\s+/)
  .filter(Boolean);

assert.deepStrictEqual(actualTests, expectedTests);
assert.strictEqual(new Set(actualTests).size, actualTests.length, 'runtime hotfix smoke should not duplicate test files');

console.log('runtimeHotfixSmokeScript.test.js passed');
