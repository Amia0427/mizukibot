const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  canonicalJsonlDigest,
  validateHarnessEvalManifest
} = require('../scripts/check-harness-eval-fixtures');

function writeManifestFixture(rootDir, cases, overrides = {}) {
  const fixturePath = path.join(rootDir, 'cases.jsonl');
  const text = cases.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(fixturePath, text, 'utf8');
  const manifestPath = path.join(rootDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 'harness_eval_manifest_v1',
    version: '1.0.0',
    dataPolicy: 'synthetic_only',
    suites: [{
      id: 'fixture-contract',
      caseSchemaVersion: 'fixture_contract_v1',
      runner: 'tests/fixtureContract.test.js',
      cases: 'cases.jsonl',
      caseCount: cases.length,
      canonicalSha256: crypto.createHash('sha256').update(text).digest('hex'),
      ...(overrides.suite || {})
    }],
    ...(overrides.manifest || {})
  }, null, 2), 'utf8');
  return manifestPath;
}

const trackedManifest = path.join(__dirname, 'fixtures', 'harness-eval-manifest.json');
const trackedReport = validateHarnessEvalManifest(trackedManifest);
assert.strictEqual(trackedReport.schemaVersion, 'harness_eval_manifest_v1');
assert.strictEqual(trackedReport.version, '1.0.0');
assert.strictEqual(trackedReport.suites, 2);
assert.strictEqual(trackedReport.cases, 52);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.strictEqual(
  packageJson.scripts['eval:harness:ci'],
  'node scripts/check-harness-eval-fixtures.js && node scripts/run-tests.js tests/memoryRecallStabilityCases.test.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-harness-eval-fixtures-'));
try {
  const validManifest = writeManifestFixture(tempRoot, [{ id: 'case-1', query: 'synthetic query' }]);
  assert.strictEqual(validateHarnessEvalManifest(validManifest).cases, 1);
  const reservedUrlManifest = writeManifestFixture(tempRoot, [{
    id: 'case-1',
    query: 'open https://example.com/synthetic-case'
  }]);
  assert.strictEqual(validateHarnessEvalManifest(reservedUrlManifest).cases, 1);
  assert.strictEqual(
    canonicalJsonlDigest(' {"id":"case-1"}\r\n\r\n'),
    crypto.createHash('sha256').update('{"id":"case-1"}').digest('hex')
  );

  const badHash = writeManifestFixture(tempRoot, [{ id: 'case-1' }], {
    suite: { canonicalSha256: '0'.repeat(64) }
  });
  assert.throws(() => validateHarnessEvalManifest(badHash), /fixture-contract.*digest/i);

  const empty = writeManifestFixture(tempRoot, [], {
    suite: { caseCount: 1 }
  });
  assert.throws(() => validateHarnessEvalManifest(empty), /fixture-contract.*empty/i);

  const escapedPath = writeManifestFixture(tempRoot, [{ id: 'case-1' }], {
    suite: { cases: '../outside.jsonl' }
  });
  assert.throws(() => validateHarnessEvalManifest(escapedPath), /fixture-contract.*inside.*manifest/i);

  const duplicate = writeManifestFixture(tempRoot, [{ id: 'duplicate' }, { id: 'duplicate' }]);
  assert.throws(() => validateHarnessEvalManifest(duplicate), /fixture-contract.*duplicate/i);

  for (const [label, item] of [
    ['numeric account', { id: 'case-1', job: { userId: '123456789' } }],
    ['numeric account', { id: 'case-1', job: { user_id: 123456789 } }],
    ['numeric account', { id: 'case-1', context: { senderId: '123456789' } }],
    ['numeric account', { id: 'case-1', rollback: { ownerUserId: 123456789 } }],
    ['numeric account', { id: 'case-1', rollback: { ownerUserId: 'real-user-amy' } }],
    ['email', { id: 'case-1', query: 'contact real.user@example.com' }],
    ['url', { id: 'case-1', query: 'open https://private.corp/path' }],
    ['credential', { id: 'case-1', query: 'token=liveCredential987' }]
  ]) {
    const manifestPath = writeManifestFixture(tempRoot, [item]);
    assert.throws(
      () => validateHarnessEvalManifest(manifestPath),
      new RegExp(`fixture-contract.*${label}`, 'i')
    );
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('harnessEvalFixtures.test.js passed');
