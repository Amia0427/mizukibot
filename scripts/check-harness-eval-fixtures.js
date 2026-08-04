#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MANIFEST_PATH,
  getHarnessSchemaContract,
  validateHarnessThresholds
} = require('./harness-eval-contract');

const MANIFEST_SCHEMA_VERSION = 'harness_eval_manifest_v2';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SYNTHETIC_CREDENTIALS = /^(?:abc123|dummy|example|fake|placeholder|redacted|test|<[^>]+>)$/i;
const EXTERNAL_RESULT_ENV = /^HARNESS_EVAL_[A-Z0-9_]+_RESULT_FILE$/;
const MEMORY_RECALL_CLASSES = new Set(['no_retrieval', 'wrong_hit', 'quality']);
const MEMORY_RECALL_FACETS = new Set([
  'preference',
  'identity',
  'recent_continuity',
  'group_context',
  'default_continuity',
  'task_or_plan',
  'broad_recall'
]);
const SOURCE_TYPES_BY_SCHEMA = Object.freeze({
  memory_recall_stability_v1: 'fixture',
  memory_recall_eval_v2: 'generated',
  post_reply_learning_v1: 'fixture',
  live_model_task_v1: 'external',
  redacted_replay_v1: 'external'
});

function canonicalizeJsonl(text = '') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function canonicalJsonlDigest(text = '') {
  return crypto.createHash('sha256').update(canonicalizeJsonl(text)).digest('hex');
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function assertExactKeys(value, allowedKeys, label) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown[0]}`);
}

function readJsonlCases(suiteId, text) {
  const lines = canonicalizeJsonl(text).split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error(`${suiteId}: empty fixture`);
  const ids = new Set();
  return lines.map((line, index) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`${suiteId}: invalid JSON on line ${index + 1}: ${error.message}`);
    }
    requireObject(item, `${suiteId}: case on line ${index + 1} must be an object`);
    const id = String(item.id || '').trim();
    if (!id) throw new Error(`${suiteId}: case on line ${index + 1} has no id`);
    if (ids.has(id)) throw new Error(`${suiteId}: duplicate case id ${id}`);
    ids.add(id);
    return item;
  });
}

function hasNonSyntheticUrl(value) {
  const matches = String(value).match(/https?:\/\/[^\s,;]+/gi) || [];
  return matches.some((rawUrl) => {
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      return hostname !== 'example.com'
        && !hostname.endsWith('.example.com')
        && hostname !== 'example.invalid'
        && !hostname.endsWith('.invalid');
    } catch (_) {
      return true;
    }
  });
}

function validateSyntheticValue(suiteId, value, keyPath = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSyntheticValue(suiteId, item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      validateSyntheticValue(suiteId, item, keyPath ? `${keyPath}.${key}` : key);
    });
    return;
  }

  const field = keyPath.split('.').at(-1)?.replace(/\[\d+\]$/, '') || '';
  const normalizedField = field.replace(/[_-]/g, '').toLowerCase();
  const accountField = /^(?:actoruser|group|operatoruser|owneruser|sender|targetuser|user)id$/.test(normalizedField);
  const accountValue = String(value ?? '').trim();
  if (accountField && accountValue && !/^(?:actor|g|group|operator|owner|sender|target|u|user)[_-](?:eval|synthetic|test)(?:[_-][a-z0-9]+)*$/i.test(accountValue)) {
    throw new Error(`${suiteId}: numeric account or non-synthetic account found at ${keyPath}`);
  }
  if (typeof value !== 'string') return;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) {
    throw new Error(`${suiteId}: email found at ${keyPath}`);
  }
  if (hasNonSyntheticUrl(value)) {
    throw new Error(`${suiteId}: url found at ${keyPath}`);
  }
  if (/(?:^|\D)\d{7,}(?:\D|$)/.test(value)) {
    throw new Error(`${suiteId}: numeric account found at ${keyPath}`);
  }
  const credentialField = /(?:api[_-]?key|password|secret|token)/i.test(field);
  const credentialMatch = value.match(/(?:api[_-]?key|password|secret|token)\s*[:=]\s*([^\s,;]+)/i);
  const credentialValue = credentialMatch?.[1] || (credentialField ? value.trim() : '');
  if (credentialValue && !SYNTHETIC_CREDENTIALS.test(credentialValue)) {
    throw new Error(`${suiteId}: credential value is not an approved placeholder at ${keyPath}`);
  }
}

function resolveInside(baseDir, suiteId, value, label) {
  const resolvedPath = path.resolve(baseDir, String(value || ''));
  const relative = path.relative(baseDir, resolvedPath);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!relative || outside) {
    throw new Error(`${suiteId}: ${label} path must stay inside ${label === 'runner' ? 'the project' : 'the manifest directory'}`);
  }
  return resolvedPath;
}

function validateMemoryRecallCase(suiteId, item) {
  assertExactKeys(item, ['id', 'class', 'query', 'shouldUseMemory', 'expectedFacet'], `${suiteId}: case ${item.id}`);
  if (typeof item.shouldUseMemory !== 'boolean') throw new Error(`${suiteId}: case ${item.id} shouldUseMemory must be boolean`);
  if (!MEMORY_RECALL_CLASSES.has(item.class)) throw new Error(`${suiteId}: case ${item.id} class is invalid`);
  if (!String(item.query || '').trim()) throw new Error(`${suiteId}: case ${item.id} query is required`);
  if (!MEMORY_RECALL_FACETS.has(item.expectedFacet)) {
    throw new Error(`${suiteId}: case ${item.id} expectedFacet is invalid`);
  }
}

function validatePostReplyCase(suiteId, item) {
  const discriminators = ['job', 'enrich', 'budget', 'rollback', 'recovery'];
  const active = discriminators.filter((key) => Object.hasOwn(item, key));
  const allowedKeys = ['id', 'expected', 'context'].concat(discriminators);
  assertExactKeys(item, allowedKeys, `${suiteId}: case ${item.id}`);
  if (active.length !== 1 || (Object.hasOwn(item, 'context') && active[0] !== 'enrich')) {
    throw new Error(`${suiteId}: case ${item.id} has invalid case shape`);
  }
  requireObject(item.expected, `${suiteId}: case ${item.id} expected must be an object`);
  if (active[0] === 'enrich' && Array.isArray(item.enrich)) {
    if (item.enrich.length === 0) throw new Error(`${suiteId}: case ${item.id} enrich must not be empty`);
    item.enrich.forEach((candidate, index) => {
      requireObject(candidate, `${suiteId}: case ${item.id} enrich[${index}] must be an object`);
    });
  } else {
    requireObject(item[active[0]], `${suiteId}: case ${item.id} ${active[0]} must be an object`);
  }
  if (Object.hasOwn(item, 'context')) {
    requireObject(item.context, `${suiteId}: case ${item.id} context must be an object`);
  }
}

function validateCaseShape(suiteId, caseSchemaVersion, item) {
  if (caseSchemaVersion === 'memory_recall_stability_v1') {
    validateMemoryRecallCase(suiteId, item);
    return;
  }
  if (caseSchemaVersion === 'post_reply_learning_v1') {
    validatePostReplyCase(suiteId, item);
    return;
  }
  throw new Error(`${suiteId}: case schema ${caseSchemaVersion} does not accept fixture cases`);
}

function validateNodeRunner(suiteId, runner, projectRoot) {
  assertExactKeys(runner, ['type', 'path', 'timeoutMs', 'maxOutputBytes'], `${suiteId}: runner`);
  const runnerPath = resolveInside(projectRoot, suiteId, runner.path, 'runner');
  if (!fs.existsSync(runnerPath) || !fs.statSync(runnerPath).isFile()) {
    throw new Error(`${suiteId}: runner not found: ${runner.path}`);
  }
  if (!Number.isInteger(runner.timeoutMs) || runner.timeoutMs < 100) {
    throw new Error(`${suiteId}: runner timeoutMs must be an integer of at least 100`);
  }
  if (!Number.isInteger(runner.maxOutputBytes) || runner.maxOutputBytes < 1024) {
    throw new Error(`${suiteId}: runner maxOutputBytes must be an integer of at least 1024`);
  }
  return runnerPath;
}

function validateExternalRunner(suiteId, runner, externalEnvs) {
  assertExactKeys(runner, ['type', 'resultFileEnv', 'maxBytes', 'maxAgeHours', 'minCaseCount'], `${suiteId}: runner`);
  if (!EXTERNAL_RESULT_ENV.test(String(runner.resultFileEnv || ''))) {
    throw new Error(`${suiteId}: external runner resultFileEnv is invalid`);
  }
  if (externalEnvs.has(runner.resultFileEnv)) {
    throw new Error(`${suiteId}: external runner resultFileEnv is duplicated`);
  }
  externalEnvs.add(runner.resultFileEnv);
  if (!Number.isInteger(runner.maxBytes) || runner.maxBytes < 1024 || runner.maxBytes > 1024 * 1024) {
    throw new Error(`${suiteId}: external runner maxBytes must be between 1024 and 1048576`);
  }
  if (!Number.isFinite(runner.maxAgeHours) || runner.maxAgeHours <= 0 || runner.maxAgeHours > 168) {
    throw new Error(`${suiteId}: external runner maxAgeHours must be between 0 and 168`);
  }
  if (!Number.isInteger(runner.minCaseCount) || runner.minCaseCount < 1) {
    throw new Error(`${suiteId}: external runner minCaseCount must be a positive integer`);
  }
}

function validateRunner(suiteId, runner, projectRoot, externalEnvs) {
  requireObject(runner, `${suiteId}: runner is required`);
  if (runner.type === 'node') return validateNodeRunner(suiteId, runner, projectRoot);
  if (runner.type === 'external_result') {
    validateExternalRunner(suiteId, runner, externalEnvs);
    return '';
  }
  throw new Error(`${suiteId}: unknown runner type ${runner.type}`);
}

function validateFixtureSource(suite, source, manifestDir) {
  assertExactKeys(source, ['type', 'path', 'caseCount', 'canonicalSha256'], `${suite.id}: source`);
  const fixturePath = resolveInside(manifestDir, suite.id, source.path, 'cases');
  if (!fs.existsSync(fixturePath) || !fs.statSync(fixturePath).isFile()) {
    throw new Error(`${suite.id}: fixture not found: ${source.path}`);
  }
  const text = fs.readFileSync(fixturePath, 'utf8');
  const cases = readJsonlCases(suite.id, text);
  cases.forEach((item, index) => {
    validateSyntheticValue(suite.id, item, `cases[${index}]`);
    validateCaseShape(suite.id, suite.caseSchemaVersion, item);
  });
  if (!Number.isInteger(source.caseCount) || source.caseCount < 1 || source.caseCount !== cases.length) {
    throw new Error(`${suite.id}: case count mismatch, expected ${source.caseCount}, got ${cases.length}`);
  }
  const digest = canonicalJsonlDigest(text);
  if (digest !== String(source.canonicalSha256 || '').toLowerCase()) {
    throw new Error(`${suite.id}: digest mismatch`);
  }
  return { fixturePath, caseCount: cases.length, digest };
}

function validateSource(suite, manifestDir) {
  const source = requireObject(suite.source, `${suite.id}: source is required`);
  const expectedType = SOURCE_TYPES_BY_SCHEMA[suite.caseSchemaVersion];
  if (source.type !== expectedType) {
    throw new Error(`${suite.id}: source type must be ${expectedType} for ${suite.caseSchemaVersion}`);
  }
  if (source.type === 'fixture') return validateFixtureSource(suite, source, manifestDir);
  assertExactKeys(source, ['type'], `${suite.id}: source`);
  return { fixturePath: '', caseCount: 0, digest: '' };
}

function loadHarnessEvalManifest(manifestPath = DEFAULT_MANIFEST_PATH, options = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`manifest JSON is invalid: ${error.message}`);
  }
  requireObject(manifest, 'manifest must be an object');
  assertExactKeys(manifest, ['schemaVersion', 'version', 'profiles', 'suites'], 'manifest');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest schema must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    throw new Error('manifest version must use semantic versioning');
  }
  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) {
    throw new Error('manifest suites must not be empty');
  }

  const manifestDir = path.dirname(resolvedManifestPath);
  const suiteIds = new Set();
  const externalEnvs = new Set();
  const suitesById = new Map();
  const details = manifest.suites.map((rawSuite) => {
    const suite = requireObject(rawSuite, 'manifest suite must be an object');
    assertExactKeys(suite, ['id', 'caseSchemaVersion', 'dataPolicy', 'runner', 'source', 'thresholds'], 'manifest suite');
    const suiteId = String(suite.id || '').trim();
    if (!suiteId) throw new Error('manifest suite id is required');
    if (suiteIds.has(suiteId)) throw new Error(`duplicate suite id ${suiteId}`);
    suiteIds.add(suiteId);

    const contract = getHarnessSchemaContract(suite.caseSchemaVersion);
    if (!contract) throw new Error(`${suiteId}: unknown case schema ${suite.caseSchemaVersion}`);
    if (suite.dataPolicy !== contract.dataPolicy) {
      throw new Error(`${suiteId}: dataPolicy must be ${contract.dataPolicy}`);
    }
    validateHarnessThresholds(suiteId, suite.caseSchemaVersion, suite.thresholds);
    const runnerPath = validateRunner(suiteId, suite.runner, projectRoot, externalEnvs);
    const source = validateSource(suite, manifestDir);
    if ((suite.runner.type === 'external_result') !== (suite.source.type === 'external')) {
      throw new Error(`${suiteId}: runner type does not match source type`);
    }

    const normalizedSuite = {
      ...suite,
      runnerPath,
      fixturePath: source.fixturePath
    };
    suitesById.set(suiteId, normalizedSuite);
    return {
      id: suiteId,
      runnerType: suite.runner.type,
      cases: source.caseCount,
      digest: source.digest
    };
  });

  const profiles = requireObject(manifest.profiles, 'manifest profiles must be an object');
  if (Object.keys(profiles).length === 0) throw new Error('manifest profiles must not be empty');
  const profileCounts = {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    requireObject(profile, `profile ${profileId} must be an object`);
    assertExactKeys(profile, ['suites'], `profile ${profileId}`);
    if (!Array.isArray(profile.suites) || profile.suites.length === 0) {
      throw new Error(`profile ${profileId} suites must not be empty`);
    }
    const unique = new Set();
    for (const suiteId of profile.suites) {
      if (!suitesById.has(suiteId)) throw new Error(`profile ${profileId} references unknown suite ${suiteId}`);
      if (unique.has(suiteId)) throw new Error(`profile ${profileId} has duplicate suite ${suiteId}`);
      unique.add(suiteId);
    }
    profileCounts[profileId] = profile.suites.length;
  }

  return {
    manifestPath: resolvedManifestPath,
    projectRoot,
    manifest,
    suitesById,
    details,
    profileCounts
  };
}

function validateHarnessEvalManifest(manifestPath = DEFAULT_MANIFEST_PATH, options = {}) {
  const loaded = loadHarnessEvalManifest(manifestPath, options);
  return {
    schemaVersion: loaded.manifest.schemaVersion,
    version: loaded.manifest.version,
    suites: loaded.details.length,
    cases: loaded.details.reduce((total, suite) => total + suite.cases, 0),
    profiles: loaded.profileCounts,
    details: loaded.details
  };
}

function main() {
  const report = validateHarnessEvalManifest(process.argv[2] || DEFAULT_MANIFEST_PATH);
  console.log(`[harness-eval] manifest ${report.version}: ${report.suites} suites, ${report.cases} fixture cases passed`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[harness-eval] failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  canonicalJsonlDigest,
  loadHarnessEvalManifest,
  validateHarnessEvalManifest
};
