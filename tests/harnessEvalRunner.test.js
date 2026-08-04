'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  executeHarnessEval
} = require('../scripts/run-harness-eval');
const {
  SUITE_RESULT_SCHEMA_VERSION
} = require('../scripts/harness-eval-contract');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function memoryCase(id) {
  return {
    id,
    class: 'quality',
    query: `synthetic query ${id}`,
    shouldUseMemory: true,
    expectedFacet: 'preference'
  };
}

function writeNodeFixture(rootDir, name, options = {}) {
  const suiteDir = path.join(rootDir, name);
  fs.mkdirSync(suiteDir, { recursive: true });
  const cases = [memoryCase('case-1'), memoryCase('case-2')];
  const casesText = cases.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(path.join(suiteDir, 'cases.jsonl'), casesText, 'utf8');

  const result = {
    schemaVersion: SUITE_RESULT_SCHEMA_VERSION,
    suiteId: 'fixture-suite',
    caseSchemaVersion: 'memory_recall_stability_v1',
    dataPolicy: 'synthetic_only',
    caseCount: 2,
    completedCaseCount: 2,
    metrics: {
      passRate: options.passRate ?? 1,
      failedCases: options.failedCases ?? 0
    }
  };
  let runnerSource;
  if (options.mode === 'no-result') {
    runnerSource = "console.log('no result');\n";
  } else if (options.mode === 'exit') {
    runnerSource = "process.exitCode = 7;\n";
  } else if (options.mode === 'hang') {
    runnerSource = "setInterval(() => {}, 1000);\n";
  } else if (options.mode === 'overflow') {
    runnerSource = "process.stdout.write('x'.repeat(4096));\nsetInterval(() => {}, 1000);\n";
  } else if (options.mode === 'large-result') {
    runnerSource = "const fs = require('fs');\nfs.writeFileSync(process.env.HARNESS_EVAL_RESULT_FILE, 'x'.repeat(4096), 'utf8');\n";
  } else {
    runnerSource = [
      "const fs = require('fs');",
      "if (process.env.HARNESS_EVAL_SENTINEL_SECRET) throw new Error('sentinel leaked');",
      `fs.writeFileSync(process.env.HARNESS_EVAL_RESULT_FILE, ${JSON.stringify(JSON.stringify(result))}, 'utf8');`
    ].join('\n');
  }
  fs.writeFileSync(path.join(suiteDir, 'runner.js'), runnerSource, 'utf8');

  const manifest = {
    schemaVersion: 'harness_eval_manifest_v2',
    version: '2.0.0',
    profiles: {
      ci: { suites: ['fixture-suite'] }
    },
    suites: [{
      id: 'fixture-suite',
      caseSchemaVersion: 'memory_recall_stability_v1',
      dataPolicy: 'synthetic_only',
      runner: {
        type: 'node',
        path: `${name}/runner.js`,
        timeoutMs: options.timeoutMs || 1000,
        maxOutputBytes: options.maxOutputBytes || 4096
      },
      source: {
        type: 'fixture',
        path: 'cases.jsonl',
        caseCount: 2,
        canonicalSha256: sha256(casesText)
      },
      thresholds: {
        passRate: { min: options.minimumPassRate ?? 1 },
        failedCases: { max: options.maximumFailedCases ?? 0 }
      }
    }]
  };
  const manifestPath = path.join(suiteDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return {
    manifestPath,
    reportPath: path.join(suiteDir, 'report.json')
  };
}

function externalResult(suiteId, caseSchemaVersion, dataPolicy, caseCount, producer) {
  return {
    schemaVersion: SUITE_RESULT_SCHEMA_VERSION,
    suiteId,
    caseSchemaVersion,
    dataPolicy,
    caseCount,
    completedCaseCount: caseCount,
    metrics: caseSchemaVersion === 'redacted_replay_v1'
      ? { passRate: 1, failedCases: 0, privacyViolations: 0 }
      : { passRate: 1, failedCases: 0 },
    producer
  };
}

function writeExternalFixture(rootDir, now) {
  const suiteDir = path.join(rootDir, 'external');
  fs.mkdirSync(suiteDir, { recursive: true });
  const manifest = {
    schemaVersion: 'harness_eval_manifest_v2',
    version: '2.0.0',
    profiles: {
      'nightly:verify': { suites: ['live', 'replay'] }
    },
    suites: [{
      id: 'live',
      caseSchemaVersion: 'live_model_task_v1',
      dataPolicy: 'synthetic_only',
      runner: {
        type: 'external_result',
        resultFileEnv: 'HARNESS_EVAL_LIVE_RESULT_FILE',
        maxBytes: 8192,
        maxAgeHours: 48,
        minCaseCount: 2
      },
      source: { type: 'external' },
      thresholds: {
        passRate: { min: 1 },
        failedCases: { max: 0 }
      }
    }, {
      id: 'replay',
      caseSchemaVersion: 'redacted_replay_v1',
      dataPolicy: 'redacted_only',
      runner: {
        type: 'external_result',
        resultFileEnv: 'HARNESS_EVAL_REPLAY_RESULT_FILE',
        maxBytes: 8192,
        maxAgeHours: 48,
        minCaseCount: 3
      },
      source: { type: 'external' },
      thresholds: {
        passRate: { min: 1 },
        failedCases: { max: 0 },
        privacyViolations: { max: 0 }
      }
    }]
  };
  const manifestPath = path.join(suiteDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const commonProducer = {
    producerVersion: '1.0.0',
    runId: 'synthetic-run-1',
    generatedAt: new Date(now).toISOString(),
    inputDigest: '1'.repeat(64),
    configHash: '2'.repeat(64)
  };
  const livePath = path.join(suiteDir, 'live.json');
  fs.writeFileSync(livePath, JSON.stringify(externalResult(
    'live',
    'live_model_task_v1',
    'synthetic_only',
    2,
    { ...commonProducer, model: 'synthetic-model', invocationCount: 2 }
  )), 'utf8');
  const replayPath = path.join(suiteDir, 'replay.json');
  fs.writeFileSync(replayPath, JSON.stringify(externalResult(
    'replay',
    'redacted_replay_v1',
    'redacted_only',
    3,
    { ...commonProducer, replayCaseCount: 3, redactionPolicyVersion: '1.0.0' }
  )), 'utf8');
  return { manifestPath, livePath, replayPath, suiteDir };
}

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-harness-eval-runner-'));
  try {
    process.env.HARNESS_EVAL_SENTINEL_SECRET = 'must-not-leak';
    const relaxed = writeNodeFixture(tempRoot, 'relaxed', {
      passRate: 0.5,
      failedCases: 1,
      minimumPassRate: 0.5,
      maximumFailedCases: 1
    });
    const relaxedReport = await executeHarnessEval({
      manifestPath: relaxed.manifestPath,
      profile: 'ci',
      reportPath: relaxed.reportPath,
      projectRoot: tempRoot
    });
    assert.strictEqual(relaxedReport.status, 'passed');
    assert.strictEqual(relaxedReport.suites[0].metrics.passRate, 0.5);
    assert.deepStrictEqual(Object.keys(relaxedReport), [
      'schemaVersion',
      'status',
      'profile',
      'manifest',
      'startedAt',
      'finishedAt',
      'suites',
      'error'
    ]);
    assert.deepStrictEqual(Object.keys(relaxedReport.suites[0]), [
      'id',
      'status',
      'caseSchemaVersion',
      'dataPolicy',
      'caseCount',
      'completedCaseCount',
      'metrics',
      'thresholds',
      'error'
    ]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(relaxed.reportPath, 'utf8')), relaxedReport);

    for (const [name, mode, errorCode] of [
      ['missing-result', 'no-result', 'result_missing'],
      ['nonzero-exit', 'exit', 'runner_exit'],
      ['timeout', 'hang', 'runner_timeout'],
      ['overflow', 'overflow', 'runner_output_limit'],
      ['large-result', 'large-result', 'result_invalid']
    ]) {
      const fixture = writeNodeFixture(tempRoot, name, {
        mode,
        timeoutMs: 150,
        maxOutputBytes: 1024
      });
      const report = await executeHarnessEval({
        manifestPath: fixture.manifestPath,
        profile: 'ci',
        reportPath: fixture.reportPath,
        projectRoot: tempRoot
      });
      assert.strictEqual(report.status, 'failed', name);
      assert.strictEqual(report.suites[0].error.code, errorCode, name);
    }

    const invalidManifestPath = path.join(tempRoot, 'invalid.json');
    const invalidReportPath = path.join(tempRoot, 'invalid-report.json');
    fs.writeFileSync(invalidManifestPath, '{ invalid', 'utf8');
    const invalidReport = await executeHarnessEval({
      manifestPath: invalidManifestPath,
      profile: 'ci',
      reportPath: invalidReportPath,
      projectRoot: tempRoot
    });
    assert.strictEqual(invalidReport.status, 'failed');
    assert.strictEqual(invalidReport.error.code, 'manifest_invalid');
    assert.deepStrictEqual(invalidReport.suites, []);

    const unknownProfileFixture = writeNodeFixture(tempRoot, 'unknown-profile');
    const unknownProfileReport = await executeHarnessEval({
      manifestPath: unknownProfileFixture.manifestPath,
      profile: 'missing',
      reportPath: unknownProfileFixture.reportPath,
      projectRoot: tempRoot
    });
    assert.strictEqual(unknownProfileReport.error.code, 'unknown_profile');
    assert.deepStrictEqual(unknownProfileReport.suites, []);

    const now = Date.parse('2026-08-02T05:00:00.000Z');
    const external = writeExternalFixture(tempRoot, now);
    const missingExternalReport = await executeHarnessEval({
      manifestPath: external.manifestPath,
      profile: 'nightly:verify',
      reportPath: path.join(external.suiteDir, 'missing-report.json'),
      projectRoot: tempRoot,
      env: {},
      now
    });
    assert.strictEqual(missingExternalReport.status, 'failed');
    assert.deepStrictEqual(
      missingExternalReport.suites.map((suite) => suite.error.code),
      ['external_input_missing', 'external_input_missing']
    );

    const externalReport = await executeHarnessEval({
      manifestPath: external.manifestPath,
      profile: 'nightly:verify',
      reportPath: path.join(external.suiteDir, 'report.json'),
      projectRoot: tempRoot,
      env: {
        HARNESS_EVAL_LIVE_RESULT_FILE: external.livePath,
        HARNESS_EVAL_REPLAY_RESULT_FILE: external.replayPath
      },
      now
    });
    assert.strictEqual(externalReport.status, 'passed');

    const insufficient = JSON.parse(fs.readFileSync(external.livePath, 'utf8'));
    insufficient.caseCount = 1;
    insufficient.completedCaseCount = 1;
    insufficient.producer.invocationCount = 1;
    fs.writeFileSync(external.livePath, JSON.stringify(insufficient), 'utf8');
    const insufficientReport = await executeHarnessEval({
      manifestPath: external.manifestPath,
      profile: 'nightly:verify',
      reportPath: path.join(external.suiteDir, 'insufficient-report.json'),
      projectRoot: tempRoot,
      env: {
        HARNESS_EVAL_LIVE_RESULT_FILE: external.livePath,
        HARNESS_EVAL_REPLAY_RESULT_FILE: external.replayPath
      },
      now
    });
    assert.strictEqual(insufficientReport.suites[0].error.code, 'result_invalid');

    const validLive = externalResult(
      'live',
      'live_model_task_v1',
      'synthetic_only',
      2,
      {
        producerVersion: '1.0.0',
        runId: 'synthetic-run-2',
        generatedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
        inputDigest: '1'.repeat(64),
        configHash: '2'.repeat(64),
        model: 'synthetic-model',
        invocationCount: 2
      }
    );
    fs.writeFileSync(external.livePath, JSON.stringify(validLive), 'utf8');
    const expiredReport = await executeHarnessEval({
      manifestPath: external.manifestPath,
      profile: 'nightly:verify',
      reportPath: path.join(external.suiteDir, 'expired-report.json'),
      projectRoot: tempRoot,
      env: {
        HARNESS_EVAL_LIVE_RESULT_FILE: external.livePath,
        HARNESS_EVAL_REPLAY_RESULT_FILE: external.replayPath
      },
      now
    });
    assert.match(expiredReport.suites[0].error.message, /expired/i);

    validLive.producer.generatedAt = new Date(now).toISOString();
    delete validLive.producer.model;
    fs.writeFileSync(external.livePath, JSON.stringify(validLive), 'utf8');
    const incompleteMetadataReport = await executeHarnessEval({
      manifestPath: external.manifestPath,
      profile: 'nightly:verify',
      reportPath: path.join(external.suiteDir, 'incomplete-metadata-report.json'),
      projectRoot: tempRoot,
      env: {
        HARNESS_EVAL_LIVE_RESULT_FILE: external.livePath,
        HARNESS_EVAL_REPLAY_RESULT_FILE: external.replayPath
      },
      now
    });
    assert.match(incompleteMetadataReport.suites[0].error.message, /producer\.model is required/i);

    const unwritableParent = path.join(tempRoot, 'not-a-directory');
    fs.writeFileSync(unwritableParent, 'file', 'utf8');
    await assert.rejects(
      executeHarnessEval({
        manifestPath: external.manifestPath,
        profile: 'nightly:verify',
        reportPath: path.join(unwritableParent, 'report.json'),
        projectRoot: tempRoot,
        env: {},
        now
      }),
      /not-a-directory|ENOTDIR|directory/i
    );
  } finally {
    delete process.env.HARNESS_EVAL_SENTINEL_SECRET;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('harnessEvalRunner.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
