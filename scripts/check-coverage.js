'use strict';

const fs = require('fs');
const path = require('path');

const METRICS = Object.freeze(['lines', 'statements', 'functions', 'branches']);

function validateBaseline(baseline) {
  const errors = [];
  if (baseline?.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(baseline?.include) || baseline.include.length === 0) {
    errors.push('include must be a non-empty array');
  } else if (baseline.include.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('include entries must be non-empty strings');
  }
  const scopes = Array.isArray(baseline?.scopes) ? baseline.scopes : [];
  if (scopes.length === 0) errors.push('scopes must be a non-empty array');
  const names = new Set();
  for (const [index, scope] of scopes.entries()) {
    const name = String(scope?.name || '').trim();
    if (!name) errors.push(`scope[${index}] name is required`);
    if (name && names.has(name)) errors.push(`duplicate scope name: ${name}`);
    if (name) names.add(name);

    const selector = scope?.selector || {};
    for (const key of ['files', 'prefixes', 'excludeSuffixes']) {
      if (selector[key] !== undefined && (
        !Array.isArray(selector[key])
        || selector[key].some((item) => typeof item !== 'string' || !item.trim())
      )) {
        errors.push(`${name || `scope[${index}]`}: selector.${key} must contain non-empty strings`);
      }
    }
    const hasSelector = selector.all === true
      || (Array.isArray(selector.files) && selector.files.length > 0)
      || (Array.isArray(selector.prefixes) && selector.prefixes.length > 0);
    if (!hasSelector) errors.push(`${name || `scope[${index}]`}: selector is required`);

    for (const metric of METRICS) {
      const minimum = scope?.minimum?.[metric];
      if (typeof minimum !== 'number' || !Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
        errors.push(`${name || `scope[${index}]`}: ${metric} minimum must be a number from 0 to 100`);
      }
    }
  }
  return errors;
}

function normalizePath(rootDir, filePath) {
  return path.relative(rootDir, path.resolve(filePath)).replace(/\\/g, '/');
}

function listCoverageFiles(summary, rootDir) {
  return Object.entries(summary)
    .filter(([filePath]) => filePath !== 'total')
    .map(([filePath, metrics]) => ({
      file: normalizePath(rootDir, filePath),
      metrics
    }));
}

function validateCoverageEntries(entries) {
  const errors = [];
  if (entries.length === 0) errors.push('no source files found');
  for (const entry of entries) {
    for (const metric of METRICS) {
      const values = entry.metrics?.[metric];
      const total = values?.total;
      const covered = values?.covered;
      if (!Number.isInteger(total) || total < 0) {
        errors.push(`${entry.file}: ${metric}.total must be a non-negative integer`);
        continue;
      }
      if (!Number.isInteger(covered) || covered < 0 || covered > total) {
        errors.push(`${entry.file}: ${metric}.covered must be an integer from 0 to total`);
      }
    }
  }
  return errors;
}

function selectScopeFiles(entries, selector = {}) {
  let selected = selector.all === true
    ? entries
    : entries.filter((entry) => {
        if (Array.isArray(selector.files)) return selector.files.includes(entry.file);
        const prefixes = Array.isArray(selector.prefixes) ? selector.prefixes : [];
        return prefixes.some((prefix) => entry.file.startsWith(prefix));
      });
  const excludedSuffixes = Array.isArray(selector.excludeSuffixes) ? selector.excludeSuffixes : [];
  if (excludedSuffixes.length > 0) {
    selected = selected.filter((entry) => !excludedSuffixes.some((suffix) => entry.file.endsWith(suffix)));
  }
  return selected;
}

function aggregateMetrics(entries) {
  const result = { files: entries.length };
  for (const metric of METRICS) {
    const total = entries.reduce((sum, entry) => sum + Number(entry.metrics?.[metric]?.total || 0), 0);
    const covered = entries.reduce((sum, entry) => sum + Number(entry.metrics?.[metric]?.covered || 0), 0);
    result[metric] = {
      total,
      covered,
      pct: total > 0 ? (covered / total) * 100 : 100
    };
  }
  return result;
}

function checkCoverageSummary(summary, baseline, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const entries = listCoverageFiles(summary, rootDir);
  const failures = [
    ...validateBaseline(baseline).map((error) => `invalid baseline: ${error}`),
    ...validateCoverageEntries(entries).map((error) => `invalid coverage: ${error}`)
  ];
  const scopes = [];

  if (failures.length > 0) {
    return {
      version: 1,
      status: 'failed',
      generatedAt: new Date().toISOString(),
      sourceFileCount: entries.length,
      scopes,
      failures
    };
  }

  for (const scope of baseline.scopes || []) {
    const selected = selectScopeFiles(entries, scope.selector);
    if (selected.length === 0) {
      failures.push(`${scope.name}: no coverage files matched`);
      continue;
    }
    if (Array.isArray(scope.selector?.files)) {
      const found = new Set(selected.map((entry) => entry.file));
      for (const expected of scope.selector.files) {
        if (!found.has(expected)) failures.push(`${scope.name}: missing ${expected}`);
      }
    }
    const metrics = aggregateMetrics(selected);
    scopes.push({ name: scope.name, ...metrics });
    for (const metric of METRICS) {
      const minimum = scope.minimum[metric];
      if (metrics[metric].pct + Number.EPSILON < minimum) {
        failures.push(`${scope.name}: ${metric} ${metrics[metric].pct.toFixed(2)} < ${minimum.toFixed(2)}`);
      }
    }
  }

  return {
    version: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    sourceFileCount: entries.length,
    scopes,
    failures
  };
}

function checkCoverageFiles({ summaryPath, baselinePath, outputPath, rootDir = process.cwd() }) {
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const result = checkCoverageSummary(summary, baseline, { rootDir });
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

if (require.main === module) {
  const rootDir = path.resolve(__dirname, '..');
  const summaryPath = path.resolve(process.argv[2] || path.join(rootDir, 'artifacts', 'coverage', 'coverage-summary.json'));
  const baselinePath = path.resolve(process.argv[3] || path.join(rootDir, 'config', 'coverage-baseline.json'));
  const outputPath = path.resolve(process.argv[4] || path.join(rootDir, 'artifacts', 'coverage', 'baseline-check.json'));
  const result = checkCoverageFiles({ summaryPath, baselinePath, outputPath, rootDir });
  for (const scope of result.scopes) {
    console.log(`[coverage] ${scope.name} lines=${scope.lines.pct.toFixed(2)} functions=${scope.functions.pct.toFixed(2)} branches=${scope.branches.pct.toFixed(2)}`);
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`[coverage] ${failure}`);
    process.exit(1);
  }
  console.log('[coverage] baseline passed');
}

module.exports = {
  aggregateMetrics,
  checkCoverageFiles,
  checkCoverageSummary,
  listCoverageFiles,
  selectScopeFiles,
  validateCoverageEntries,
  validateBaseline
};
