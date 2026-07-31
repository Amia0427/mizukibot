#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_SCHEMA_VERSION = 'harness_eval_manifest_v1';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'harness-eval-manifest.json');
const SYNTHETIC_CREDENTIALS = /^(?:abc123|dummy|example|fake|placeholder|redacted|test|<[^>]+>)$/i;

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
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${suiteId}: case on line ${index + 1} must be an object`);
    }
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

function resolveFixturePath(manifestDir, suiteId, relativePath) {
  const fixturePath = path.resolve(manifestDir, String(relativePath || ''));
  const relative = path.relative(manifestDir, fixturePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${suiteId}: cases path must stay inside the manifest directory`);
  }
  return fixturePath;
}

function validateHarnessEvalManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest schema must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    throw new Error('manifest version must use semantic versioning');
  }
  if (manifest.dataPolicy !== 'synthetic_only') {
    throw new Error('manifest dataPolicy must be synthetic_only');
  }
  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) {
    throw new Error('manifest suites must not be empty');
  }

  const manifestDir = path.dirname(resolvedManifestPath);
  const suiteIds = new Set();
  const details = manifest.suites.map((suite) => {
    const suiteId = String(suite?.id || '').trim();
    if (!suiteId) throw new Error('manifest suite id is required');
    if (suiteIds.has(suiteId)) throw new Error(`duplicate suite id ${suiteId}`);
    suiteIds.add(suiteId);
    if (!String(suite.caseSchemaVersion || '').trim()) {
      throw new Error(`${suiteId}: caseSchemaVersion is required`);
    }
    if (!String(suite.runner || '').trim()) throw new Error(`${suiteId}: runner is required`);
    const fixturePath = resolveFixturePath(manifestDir, suiteId, suite.cases);
    const text = fs.readFileSync(fixturePath, 'utf8');
    const cases = readJsonlCases(suiteId, text);
    cases.forEach((item, index) => validateSyntheticValue(suiteId, item, `cases[${index}]`));
    if (!Number.isInteger(suite.caseCount) || suite.caseCount < 1 || suite.caseCount !== cases.length) {
      throw new Error(`${suiteId}: case count mismatch, expected ${suite.caseCount}, got ${cases.length}`);
    }
    const digest = canonicalJsonlDigest(text);
    if (digest !== String(suite.canonicalSha256 || '').toLowerCase()) {
      throw new Error(`${suiteId}: digest mismatch`);
    }
    return { id: suiteId, cases: cases.length, digest };
  });

  return {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    suites: details.length,
    cases: details.reduce((total, suite) => total + suite.cases, 0),
    details
  };
}

function main() {
  const report = validateHarnessEvalManifest(process.argv[2] || DEFAULT_MANIFEST_PATH);
  console.log(`[harness-eval] manifest ${report.version}: ${report.suites} suites, ${report.cases} synthetic cases passed`);
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
  canonicalJsonlDigest,
  validateHarnessEvalManifest
};
