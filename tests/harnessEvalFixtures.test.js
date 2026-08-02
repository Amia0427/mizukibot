'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SUITE_RESULT_SCHEMA_VERSION,
  resolveHarnessExecution,
  validateHarnessSuiteResult
} = require('../scripts/harness-eval-contract');
const {
  canonicalJsonlDigest,
  validateHarnessEvalManifest
} = require('../scripts/check-harness-eval-fixtures');

function memoryCase(id = 'case-1') {
  return {
    id,
    class: 'quality',
    query: 'synthetic preference query',
    shouldUseMemory: true,
    expectedFacet: 'preference'
  };
}

function writeManifestFixture(rootDir, cases, overrides = {}) {
  const fixturePath = path.join(rootDir, 'cases.jsonl');
  const text = cases.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(fixturePath, text, 'utf8');
  fs.writeFileSync(path.join(rootDir, 'runner.js'), '', 'utf8');

  const baseSuite = {
    id: 'fixture-contract',
    caseSchemaVersion: 'memory_recall_stability_v1',
    dataPolicy: 'synthetic_only',
    runner: {
      type: 'node',
      path: 'runner.js',
      timeoutMs: 1000,
      maxOutputBytes: 4096
    },
    source: {
      type: 'fixture',
      path: 'cases.jsonl',
      caseCount: cases.length,
      canonicalSha256: crypto.createHash('sha256').update(text).digest('hex')
    },
    thresholds: {
      passRate: { min: 1 },
      failedCases: { max: 0 }
    }
  };
  const suiteOverride = overrides.suite || {};
  const suite = {
    ...baseSuite,
    ...suiteOverride,
    runner: {
      ...baseSuite.runner,
      ...(suiteOverride.runner || {})
    },
    source: {
      ...baseSuite.source,
      ...(suiteOverride.source || {})
    },
    thresholds: suiteOverride.thresholds || baseSuite.thresholds
  };
  const manifest = {
    schemaVersion: 'harness_eval_manifest_v2',
    version: '2.0.0',
    profiles: {
      ci: { suites: [suite.id] }
    },
    suites: [suite],
    ...(overrides.manifest || {})
  };
  const manifestPath = path.join(rootDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

function validateTempManifest(manifestPath, rootDir) {
  return validateHarnessEvalManifest(manifestPath, { projectRoot: rootDir });
}

const trackedManifest = path.join(__dirname, 'fixtures', 'harness-eval-manifest.json');
const trackedReport = validateHarnessEvalManifest(trackedManifest);
assert.strictEqual(trackedReport.schemaVersion, 'harness_eval_manifest_v2');
assert.strictEqual(trackedReport.version, '2.0.0');
assert.strictEqual(trackedReport.suites, 5);
assert.strictEqual(trackedReport.cases, 52);
assert.deepStrictEqual(trackedReport.profiles, {
  ci: 3,
  'nightly:verify': 5
});

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.strictEqual(
  packageJson.scripts['eval:harness:ci'],
  'node scripts/run-harness-eval.js --profile ci --report artifacts/harness-eval/ci.json'
);
assert.strictEqual(
  packageJson.scripts['eval:harness:nightly:verify'],
  'node scripts/run-harness-eval.js --profile nightly:verify --report artifacts/harness-eval/nightly-verify.json'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-harness-eval-fixtures-'));
try {
  const validManifest = writeManifestFixture(tempRoot, [memoryCase()]);
  assert.strictEqual(validateTempManifest(validManifest, tempRoot).cases, 1);

  const reservedUrlManifest = writeManifestFixture(tempRoot, [{
    ...memoryCase(),
    query: 'open https://example.com/synthetic-case'
  }]);
  assert.strictEqual(validateTempManifest(reservedUrlManifest, tempRoot).cases, 1);
  assert.strictEqual(
    canonicalJsonlDigest(' {"id":"case-1"}\r\n\r\n'),
    crypto.createHash('sha256').update('{"id":"case-1"}').digest('hex')
  );

  const badHash = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { source: { canonicalSha256: '0'.repeat(64) } }
  });
  assert.throws(() => validateTempManifest(badHash, tempRoot), /fixture-contract.*digest/i);

  const empty = writeManifestFixture(tempRoot, [], {
    suite: { source: { caseCount: 1 } }
  });
  assert.throws(() => validateTempManifest(empty, tempRoot), /fixture-contract.*empty/i);

  const escapedCasesPath = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { source: { path: '../outside.jsonl' } }
  });
  assert.throws(() => validateTempManifest(escapedCasesPath, tempRoot), /fixture-contract.*inside.*manifest/i);

  const escapedRunnerPath = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { runner: { path: '../outside.js' } }
  });
  assert.throws(() => validateTempManifest(escapedRunnerPath, tempRoot), /fixture-contract.*runner.*project/i);

  const missingRunner = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { runner: { path: 'missing.js' } }
  });
  assert.throws(() => validateTempManifest(missingRunner, tempRoot), /fixture-contract.*runner.*not found/i);

  const unknownRunner = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { runner: { type: 'shell' } }
  });
  assert.throws(() => validateTempManifest(unknownRunner, tempRoot), /fixture-contract.*runner type/i);

  const unknownSchema = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { caseSchemaVersion: 'unknown_v1' }
  });
  assert.throws(() => validateTempManifest(unknownSchema, tempRoot), /fixture-contract.*case schema/i);

  const missingCaseField = writeManifestFixture(tempRoot, [{
    id: 'case-1',
    query: 'synthetic query'
  }]);
  assert.throws(() => validateTempManifest(missingCaseField, tempRoot), /fixture-contract.*shouldUseMemory/i);

  const invalidClass = writeManifestFixture(tempRoot, [{ ...memoryCase(), class: 'invented' }]);
  assert.throws(() => validateTempManifest(invalidClass, tempRoot), /fixture-contract.*class.*invalid/i);

  const invalidFacet = writeManifestFixture(tempRoot, [{ ...memoryCase(), expectedFacet: 'invented' }]);
  assert.throws(() => validateTempManifest(invalidFacet, tempRoot), /fixture-contract.*expectedFacet.*invalid/i);

  const duplicate = writeManifestFixture(tempRoot, [memoryCase('duplicate'), memoryCase('duplicate')]);
  assert.throws(() => validateTempManifest(duplicate, tempRoot), /fixture-contract.*duplicate/i);

  const unknownThresholdOperator = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: {
      thresholds: {
        passRate: { gte: 1 },
        failedCases: { max: 0 }
      }
    }
  });
  assert.throws(() => validateTempManifest(unknownThresholdOperator, tempRoot), /fixture-contract.*passRate.*threshold/i);

  const missingThreshold = writeManifestFixture(tempRoot, [memoryCase()], {
    suite: { thresholds: { passRate: { min: 1 } } }
  });
  assert.throws(() => validateTempManifest(missingThreshold, tempRoot), /fixture-contract.*failedCases.*threshold/i);

  const unknownProfileSuite = writeManifestFixture(tempRoot, [memoryCase()], {
    manifest: { profiles: { ci: { suites: ['missing-suite'] } } }
  });
  assert.throws(() => validateTempManifest(unknownProfileSuite, tempRoot), /profile ci.*missing-suite/i);

  const postReplyCases = [
    { id: 'job', job: {}, expected: {} },
    { id: 'enrich', enrich: {}, context: {}, expected: {} },
    { id: 'budget', budget: {}, expected: {} },
    { id: 'rollback', rollback: {}, expected: {} },
    { id: 'recovery', recovery: {}, expected: {} }
  ];
  const postReplyManifest = writeManifestFixture(tempRoot, postReplyCases, {
    suite: {
      caseSchemaVersion: 'post_reply_learning_v1',
      thresholds: {
        passRate: { min: 1 },
        failedCases: { max: 0 }
      }
    }
  });
  assert.strictEqual(validateTempManifest(postReplyManifest, tempRoot).cases, 5);

  for (const invalidCase of [
    { id: 'mixed', job: {}, recovery: {}, expected: {} },
    { id: 'context-with-job', job: {}, context: {}, expected: {} },
    { id: 'unsupported', expected: {} }
  ]) {
    const invalidPostReply = writeManifestFixture(tempRoot, [invalidCase], {
      suite: {
        caseSchemaVersion: 'post_reply_learning_v1',
        thresholds: {
          passRate: { min: 1 },
          failedCases: { max: 0 }
        }
      }
    });
    assert.throws(() => validateTempManifest(invalidPostReply, tempRoot), /fixture-contract.*case shape/i);
  }

  for (const [label, item] of [
    ['numeric account', { ...memoryCase(), job: { userId: '123456789' } }],
    ['numeric account', { ...memoryCase(), job: { user_id: 123456789 } }],
    ['numeric account', { ...memoryCase(), context: { senderId: '123456789' } }],
    ['numeric account', { ...memoryCase(), rollback: { ownerUserId: 123456789 } }],
    ['numeric account', { ...memoryCase(), rollback: { ownerUserId: 'real-user-amy' } }],
    ['email', { ...memoryCase(), query: 'contact real.user@example.com' }],
    ['url', { ...memoryCase(), query: 'open https://private.corp/path' }],
    ['credential', { ...memoryCase(), query: 'token=liveCredential987' }]
  ]) {
    const manifestPath = writeManifestFixture(tempRoot, [item]);
    assert.throws(
      () => validateTempManifest(manifestPath, tempRoot),
      new RegExp(`fixture-contract.*${label}`, 'i')
    );
  }

  const resultSuite = {
    id: 'fixture-contract',
    caseSchemaVersion: 'memory_recall_stability_v1',
    dataPolicy: 'synthetic_only',
    source: { type: 'fixture', caseCount: 2 },
    thresholds: {
      passRate: { min: 1 },
      failedCases: { max: 0 }
    }
  };
  const validResult = {
    schemaVersion: SUITE_RESULT_SCHEMA_VERSION,
    suiteId: 'fixture-contract',
    caseSchemaVersion: 'memory_recall_stability_v1',
    dataPolicy: 'synthetic_only',
    caseCount: 2,
    completedCaseCount: 2,
    metrics: {
      passRate: 1,
      failedCases: 0
    }
  };
  const resultValidation = validateHarnessSuiteResult(resultSuite, validResult);
  assert.strictEqual(resultValidation.passed, true);
  assert.strictEqual(resultValidation.thresholds.length, 2);

  for (const [overrides, pattern] of [
    [{ caseCount: 0, completedCaseCount: 0 }, /caseCount.*positive/i],
    [{ completedCaseCount: 1 }, /completedCaseCount.*caseCount/i],
    [{ metrics: { passRate: -1, failedCases: 0 } }, /passRate.*between 0 and 1/i],
    [{ metrics: { passRate: 2, failedCases: 0 } }, /passRate.*between 0 and 1/i],
    [{ metrics: { passRate: 1, failedCases: 0, invented: 1 } }, /unknown metric.*invented/i],
    [{ metrics: { passRate: null, failedCases: 0 } }, /passRate.*finite/i],
    [{ metrics: { passRate: 0.5, failedCases: 0 } }, /passRate.*failedCases/i],
    [{ dataPolicy: 'redacted_only' }, /dataPolicy/i],
    [{ extra: true }, /unknown result field.*extra/i]
  ]) {
    assert.throws(
      () => validateHarnessSuiteResult(resultSuite, { ...validResult, ...overrides }),
      pattern
    );
  }

  assert.throws(
    () => resolveHarnessExecution('fixture-contract', {
      HARNESS_EVAL_MANIFEST_FILE: validManifest
    }),
    /requires all of.*HARNESS_EVAL_SUITE_ID.*HARNESS_EVAL_RESULT_FILE/i
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('harnessEvalFixtures.test.js passed');
