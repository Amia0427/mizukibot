'use strict';

const fs = require('fs');
const path = require('path');

const SUITE_RESULT_SCHEMA_VERSION = 'harness_eval_suite_result_v1';
const REPORT_SCHEMA_VERSION = 'harness_eval_report_v1';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'harness-eval-manifest.json');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const SCHEMA_CONTRACTS = Object.freeze({
  memory_recall_stability_v1: Object.freeze({
    dataPolicy: 'synthetic_only',
    metrics: Object.freeze({
      passRate: Object.freeze({ type: 'ratio', operator: 'min' }),
      failedCases: Object.freeze({ type: 'count', operator: 'max' })
    })
  }),
  memory_recall_eval_v2: Object.freeze({
    dataPolicy: 'synthetic_only',
    metrics: Object.freeze({
      recallAt5: Object.freeze({ type: 'ratio', operator: 'min' }),
      mrrAt5: Object.freeze({ type: 'ratio', operator: 'min' }),
      wrongHitRate: Object.freeze({ type: 'ratio', operator: 'max' }),
      leakage: Object.freeze({ type: 'count', operator: 'max' }),
      lifecycleLeakage: Object.freeze({ type: 'count', operator: 'max' }),
      forbiddenHits: Object.freeze({ type: 'count', operator: 'max' })
    })
  }),
  post_reply_learning_v1: Object.freeze({
    dataPolicy: 'synthetic_only',
    metrics: Object.freeze({
      passRate: Object.freeze({ type: 'ratio', operator: 'min' }),
      failedCases: Object.freeze({ type: 'count', operator: 'max' })
    })
  }),
  live_model_task_v1: Object.freeze({
    dataPolicy: 'synthetic_only',
    producerType: 'live_model',
    metrics: Object.freeze({
      passRate: Object.freeze({ type: 'ratio', operator: 'min' }),
      failedCases: Object.freeze({ type: 'count', operator: 'max' })
    })
  }),
  redacted_replay_v1: Object.freeze({
    dataPolicy: 'redacted_only',
    producerType: 'redacted_replay',
    metrics: Object.freeze({
      passRate: Object.freeze({ type: 'ratio', operator: 'min' }),
      failedCases: Object.freeze({ type: 'count', operator: 'max' }),
      privacyViolations: Object.freeze({ type: 'count', operator: 'max' })
    })
  })
});

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function assertExactKeys(value, allowedKeys, label) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown[0]}`);
}

function getHarnessSchemaContract(caseSchemaVersion) {
  return SCHEMA_CONTRACTS[String(caseSchemaVersion || '').trim()] || null;
}

function validateMetricValue(metricName, value, definition) {
  if (!Number.isFinite(value)) throw new Error(`${metricName} metric must be finite`);
  if (definition.type === 'ratio' && (value < 0 || value > 1)) {
    throw new Error(`${metricName} metric must be between 0 and 1`);
  }
  if (definition.type === 'count' && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${metricName} metric must be a non-negative integer`);
  }
}

function validateHarnessThresholds(suiteId, caseSchemaVersion, thresholds) {
  const contract = getHarnessSchemaContract(caseSchemaVersion);
  if (!contract) throw new Error(`${suiteId}: unknown case schema ${caseSchemaVersion}`);
  requireObject(thresholds, `${suiteId}: thresholds must be an object`);

  const metricNames = Object.keys(contract.metrics);
  const unknownMetrics = Object.keys(thresholds).filter((name) => !metricNames.includes(name));
  if (unknownMetrics.length > 0) {
    throw new Error(`${suiteId}: unknown threshold metric ${unknownMetrics[0]}`);
  }

  for (const metricName of metricNames) {
    const definition = contract.metrics[metricName];
    const threshold = thresholds[metricName];
    requireObject(threshold, `${suiteId}: ${metricName} threshold is required`);
    const keys = Object.keys(threshold);
    if (keys.length !== 1 || keys[0] !== definition.operator) {
      throw new Error(`${suiteId}: ${metricName} threshold must use ${definition.operator}`);
    }
    validateMetricValue(metricName, threshold[definition.operator], definition);
  }
  return thresholds;
}

function evaluateThreshold(actual, operator, expected) {
  if (operator === 'min') return actual >= expected;
  if (operator === 'max') return actual <= expected;
  if (operator === 'eq') return actual === expected;
  throw new Error(`unsupported threshold operator ${operator}`);
}

function validateProducerMetadata(suite, result, contract, options = {}) {
  if (!contract.producerType) {
    if (Object.hasOwn(result, 'producer')) {
      throw new Error(`${suite.id}: local suite result must not include producer metadata`);
    }
    return;
  }

  const producer = requireObject(result.producer, `${suite.id}: producer metadata is required`);
  const commonKeys = ['producerVersion', 'runId', 'generatedAt', 'inputDigest', 'configHash'];
  const branchKeys = contract.producerType === 'live_model'
    ? ['model', 'invocationCount']
    : ['replayCaseCount', 'redactionPolicyVersion'];
  const allowedKeys = commonKeys.concat(branchKeys);
  assertExactKeys(producer, allowedKeys, `${suite.id}: producer`);

  for (const key of commonKeys.concat(branchKeys)) {
    if (!Object.hasOwn(producer, key)) throw new Error(`${suite.id}: producer.${key} is required`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(producer.producerVersion || ''))) {
    throw new Error(`${suite.id}: producer.producerVersion must use semantic versioning`);
  }
  for (const key of ['runId', 'generatedAt']) {
    if (!String(producer[key] || '').trim()) throw new Error(`${suite.id}: producer.${key} is required`);
  }
  for (const key of ['inputDigest', 'configHash']) {
    if (!SHA256_PATTERN.test(String(producer[key] || ''))) {
      throw new Error(`${suite.id}: producer.${key} must be a SHA-256 digest`);
    }
  }

  const generatedAt = Date.parse(producer.generatedAt);
  if (!Number.isFinite(generatedAt)) throw new Error(`${suite.id}: producer.generatedAt must be an ISO timestamp`);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeHours = Number(suite.runner?.maxAgeHours);
  if (generatedAt > now + 5 * 60 * 1000) throw new Error(`${suite.id}: producer.generatedAt is in the future`);
  if (Number.isFinite(maxAgeHours) && now - generatedAt > maxAgeHours * 60 * 60 * 1000) {
    throw new Error(`${suite.id}: external result is expired`);
  }

  if (contract.producerType === 'live_model') {
    if (!String(producer.model || '').trim()) throw new Error(`${suite.id}: producer.model is required`);
    if (!Number.isInteger(producer.invocationCount) || producer.invocationCount < result.caseCount) {
      throw new Error(`${suite.id}: producer.invocationCount must cover every case`);
    }
    return;
  }

  if (producer.replayCaseCount !== result.caseCount) {
    throw new Error(`${suite.id}: producer.replayCaseCount must equal caseCount`);
  }
  if (!String(producer.redactionPolicyVersion || '').trim()) {
    throw new Error(`${suite.id}: producer.redactionPolicyVersion is required`);
  }
}

function validateHarnessSuiteResult(suite, result, options = {}) {
  requireObject(suite, 'suite contract is required');
  requireObject(result, `${suite.id}: suite result must be an object`);
  const allowedFields = [
    'schemaVersion',
    'suiteId',
    'caseSchemaVersion',
    'dataPolicy',
    'caseCount',
    'completedCaseCount',
    'metrics',
    'producer'
  ];
  const unknownFields = Object.keys(result).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) throw new Error(`unknown result field ${unknownFields[0]}`);

  if (result.schemaVersion !== SUITE_RESULT_SCHEMA_VERSION) {
    throw new Error(`${suite.id}: result schema must be ${SUITE_RESULT_SCHEMA_VERSION}`);
  }
  if (result.suiteId !== suite.id) throw new Error(`${suite.id}: result suiteId mismatch`);
  if (result.caseSchemaVersion !== suite.caseSchemaVersion) {
    throw new Error(`${suite.id}: result caseSchemaVersion mismatch`);
  }

  const contract = getHarnessSchemaContract(suite.caseSchemaVersion);
  if (!contract) throw new Error(`${suite.id}: unknown case schema ${suite.caseSchemaVersion}`);
  if (suite.dataPolicy !== contract.dataPolicy || result.dataPolicy !== contract.dataPolicy) {
    throw new Error(`${suite.id}: dataPolicy must be ${contract.dataPolicy}`);
  }
  if (!Number.isInteger(result.caseCount) || result.caseCount < 1) {
    throw new Error(`${suite.id}: caseCount must be a positive integer`);
  }
  if (suite.source?.type === 'external' && result.caseCount < suite.runner.minCaseCount) {
    throw new Error(`${suite.id}: caseCount must be at least ${suite.runner.minCaseCount}`);
  }
  if (result.completedCaseCount !== result.caseCount) {
    throw new Error(`${suite.id}: completedCaseCount must equal caseCount`);
  }
  if (suite.source?.type === 'fixture' && result.caseCount !== suite.source.caseCount) {
    throw new Error(`${suite.id}: result caseCount must match fixture caseCount`);
  }

  const metrics = requireObject(result.metrics, `${suite.id}: metrics must be an object`);
  const metricNames = Object.keys(contract.metrics);
  const unknownMetrics = Object.keys(metrics).filter((name) => !metricNames.includes(name));
  if (unknownMetrics.length > 0) throw new Error(`unknown metric ${unknownMetrics[0]}`);
  for (const metricName of metricNames) {
    if (!Object.hasOwn(metrics, metricName)) throw new Error(`${suite.id}: ${metricName} metric is required`);
    validateMetricValue(metricName, metrics[metricName], contract.metrics[metricName]);
  }

  if (Object.hasOwn(metrics, 'passRate') && Object.hasOwn(metrics, 'failedCases')) {
    if (metrics.failedCases > result.caseCount) {
      throw new Error(`${suite.id}: failedCases must not exceed caseCount`);
    }
    const expectedPassRate = (result.caseCount - metrics.failedCases) / result.caseCount;
    if (Math.abs(metrics.passRate - expectedPassRate) > Number.EPSILON * 4) {
      throw new Error(`${suite.id}: passRate does not match failedCases`);
    }
  }

  validateProducerMetadata(suite, result, contract, options);
  validateHarnessThresholds(suite.id, suite.caseSchemaVersion, suite.thresholds);
  const thresholds = metricNames.map((metricName) => {
    const definition = contract.metrics[metricName];
    const expected = suite.thresholds[metricName][definition.operator];
    const actual = metrics[metricName];
    return {
      metric: metricName,
      operator: definition.operator,
      expected,
      actual,
      passed: evaluateThreshold(actual, definition.operator, expected)
    };
  });
  return {
    passed: thresholds.every((item) => item.passed),
    thresholds
  };
}

function writeJsonAtomic(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, resolvedPath);
}

function resolveHarnessExecution(defaultSuiteId, env = process.env) {
  const keys = [
    'HARNESS_EVAL_MANIFEST_FILE',
    'HARNESS_EVAL_SUITE_ID',
    'HARNESS_EVAL_RESULT_FILE'
  ];
  const present = keys.filter((key) => String(env[key] || '').trim());
  if (present.length !== 0 && present.length !== keys.length) {
    throw new Error(`Harness execution requires all of ${keys.join(', ')}`);
  }
  if (present.length === 0) {
    return {
      manifestPath: DEFAULT_MANIFEST_PATH,
      suiteId: defaultSuiteId,
      resultFile: ''
    };
  }
  if (String(env.HARNESS_EVAL_SUITE_ID).trim() !== defaultSuiteId) {
    throw new Error(`Harness suite ${env.HARNESS_EVAL_SUITE_ID} cannot execute runner for ${defaultSuiteId}`);
  }
  return {
    manifestPath: path.resolve(env.HARNESS_EVAL_MANIFEST_FILE),
    suiteId: String(env.HARNESS_EVAL_SUITE_ID).trim(),
    resultFile: path.resolve(env.HARNESS_EVAL_RESULT_FILE)
  };
}

function getHarnessSuiteContext(defaultSuiteId, options = {}) {
  const execution = resolveHarnessExecution(defaultSuiteId, options.env || process.env);
  const { loadHarnessEvalManifest } = require('./check-harness-eval-fixtures');
  const loaded = loadHarnessEvalManifest(execution.manifestPath, options);
  const suite = loaded.suitesById.get(execution.suiteId);
  if (!suite) throw new Error(`Harness suite ${execution.suiteId} not found in manifest`);
  return { ...execution, suite };
}

function completeHarnessSuite(defaultSuiteId, result, options = {}) {
  const context = getHarnessSuiteContext(defaultSuiteId, options);
  const validation = validateHarnessSuiteResult(context.suite, result, options);
  if (context.resultFile) {
    writeJsonAtomic(context.resultFile, result);
    return validation;
  }
  if (!validation.passed) {
    const failed = validation.thresholds
      .filter((item) => !item.passed)
      .map((item) => `${item.metric} ${item.operator} ${item.expected}, got ${item.actual}`)
      .join('; ');
    throw new Error(`${defaultSuiteId}: thresholds failed: ${failed}`);
  }
  return validation;
}

module.exports = {
  DEFAULT_MANIFEST_PATH,
  REPORT_SCHEMA_VERSION,
  SCHEMA_CONTRACTS,
  SUITE_RESULT_SCHEMA_VERSION,
  completeHarnessSuite,
  evaluateThreshold,
  getHarnessSchemaContract,
  getHarnessSuiteContext,
  resolveHarnessExecution,
  validateHarnessSuiteResult,
  validateHarnessThresholds,
  writeJsonAtomic
};
